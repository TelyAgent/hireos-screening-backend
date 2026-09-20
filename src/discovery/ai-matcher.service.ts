import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const MAX_RESUME_CHARS = 8000;

export type JobRequirementInput = {
  id: string;
  label: string;
  dimension: string;
  priority: string;
  hard: boolean;
  kind: string;
  evidenceStandard: string;
};

export type JobDimensionInput = {
  id: string;
  name: string;
  weight: number;
  rubric: string;
};

const AiMatchResultSchema = z.object({
  overallScore: z.number().min(0).max(100),
  coverage: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
  dimensionScores: z.array(z.object({
    dimensionId: z.string(),
    score: z.number().min(0).max(100),
    rationale: z.string().max(600),
  })),
  requirementFindings: z.array(z.object({
    requirementId: z.string(),
    met: z.boolean(),
    evidence: z.string().max(600),
  })),
  gaps: z.array(z.string().max(300)),
});
export type AiMatchResult = z.infer<typeof AiMatchResultSchema>;

// Distinguishes "the model told us this candidate doesn't fit" from "we couldn't get an
// answer at all" -- callers must never fold this into a no_match result (PRD: "AI失败不标
// no_match"), since that would silently misreport an infrastructure problem as a hiring
// judgment.
export class AiMatchError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

const SYSTEM_PROMPT = `You are a senior technical recruiter evaluating one candidate's resume against one job's confirmed hiring criteria.

Rules:
- Base every judgment strictly on the resume text provided. Never invent employers, dates, skills, or numbers that are not in the text.
- Each requirement has an evidenceStandard describing what counts as proof. Mark a requirement "met" only if the resume text actually contains evidence meeting that standard; otherwise mark it not met and explain the gap.
- A "hard" requirement that is not met should sharply reduce the overall score, even if other requirements are met.
- Score each dimension from 0-100 using that dimension's own rubric -- rubrics differ per dimension and must not be treated as a generic scale.
- overallScore (0-100) must reflect the weighted combination of dimension scores together with whether hard requirements are met, not just a raw average.
- coverage (0-1) is the fraction of requirements (weighted toward must_have) that are met.
- confidence (0-1) should be lower when the resume is sparse, ambiguous, or the evidence is indirect -- not just when the candidate looks weak.
- Respond with a single JSON object only, matching exactly this shape:
{
  "overallScore": number,
  "coverage": number,
  "confidence": number,
  "rationale": string,
  "dimensionScores": [{ "dimensionId": string, "score": number, "rationale": string }],
  "requirementFindings": [{ "requirementId": string, "met": boolean, "evidence": string }],
  "gaps": [string]
}
Include one entry in dimensionScores for every dimension given, and one entry in requirementFindings for every requirement given, using their exact ids.`;

@Injectable()
export class AiMatcherService {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl() && this.apiKey() && this.model());
  }

  private baseUrl(): string {
    return this.config.get<string>('HIREOS_AI_BASE_URL', '').trim();
  }

  private apiKey(): string {
    return this.config.get<string>('HIREOS_AI_API_KEY', '').trim();
  }

  private model(): string {
    return this.config.get<string>('HIREOS_AI_MODEL', '').trim();
  }

  private timeoutMs(): number {
    return Number(this.config.get<string>('HIREOS_AI_TIMEOUT_SECONDS', '60')) * 1000;
  }

  async evaluate(input: {
    jobTitle: string;
    jobTeam: string;
    jobSeniority: string;
    jobLocation: string;
    requirements: JobRequirementInput[];
    dimensions: JobDimensionInput[];
    resumeText: string;
  }): Promise<AiMatchResult> {
    if (!this.isConfigured()) throw new AiMatchError('AI_NOT_CONFIGURED');

    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs());
    let response: Response;
    try {
      response = await globalThis.fetch(`${this.baseUrl().replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey()}` },
        body: JSON.stringify({
          model: this.model(),
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildPrompt(input) },
          ],
          // This model spends part of its completion budget on hidden reasoning tokens
          // before it ever writes visible output -- at the default effort, a full
          // requirements+dimensions evaluation exhausted the whole budget on reasoning
          // and returned empty content (finish_reason: "length"). Capping effort keeps
          // enough of the budget free for the actual JSON answer.
          reasoning_effort: 'low',
          max_completion_tokens: 6000,
        }),
      });
    } catch (error) {
      throw new AiMatchError(error instanceof Error ? error.message : 'AI_REQUEST_FAILED', error);
    } finally {
      globalThis.clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AiMatchError(`AI_HTTP_${response.status}: ${text.slice(0, 300)}`);
    }

    const body = (await response.json().catch((error) => {
      throw new AiMatchError('AI_INVALID_RESPONSE_BODY', error);
    })) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
    const choice = body.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      // "length" here means the token budget ran out (often on hidden reasoning tokens)
      // before any visible content was written -- distinct from a genuinely empty reply.
      throw new AiMatchError(choice?.finish_reason === 'length' ? 'AI_TRUNCATED_BEFORE_OUTPUT' : 'AI_EMPTY_RESPONSE');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new AiMatchError('AI_INVALID_JSON', error);
    }
    const result = AiMatchResultSchema.safeParse(parsed);
    if (!result.success) throw new AiMatchError(`AI_SCHEMA_MISMATCH: ${result.error.message}`);
    return result.data;
  }
}

function buildPrompt(input: {
  jobTitle: string;
  jobTeam: string;
  jobSeniority: string;
  jobLocation: string;
  requirements: JobRequirementInput[];
  dimensions: JobDimensionInput[];
  resumeText: string;
}): string {
  const requirementsBlock = input.requirements
    .map((r) => `- id=${r.id} | ${r.priority}${r.hard ? ' (hard)' : ''} | dimension=${r.dimension} | ${r.label} | evidence standard: ${r.evidenceStandard}`)
    .join('\n');
  const dimensionsBlock = input.dimensions
    .map((d) => `- id=${d.id} | ${d.name} | weight=${d.weight} | rubric: ${d.rubric}`)
    .join('\n');
  const resumeText = input.resumeText.slice(0, MAX_RESUME_CHARS);
  return `# Job
Title: ${input.jobTitle}
Team: ${input.jobTeam}
Seniority: ${input.jobSeniority}
Location: ${input.jobLocation}

# Dimensions (score each using its own rubric)
${dimensionsBlock || '(none)'}

# Requirements (evaluate each against the resume text)
${requirementsBlock || '(none)'}

# Candidate resume (verbatim, may be truncated)
${resumeText}`;
}
