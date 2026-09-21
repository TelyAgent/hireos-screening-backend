import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { AiCallError, callAiForJson, isAiConfigured } from '../shared/ai-json-client';

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

// Re-exported so callers can keep catching a discovery-specific name; both point at the
// same shared AiCallError from ai-json-client.
export const AiMatchError = AiCallError;

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
    return isAiConfigured(this.config);
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
    return callAiForJson(this.config, SYSTEM_PROMPT, buildPrompt(input), AiMatchResultSchema);
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
