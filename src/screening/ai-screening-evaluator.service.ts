import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { callAiForJson, isAiConfigured } from '../shared/ai-json-client';

const MAX_RESUME_CHARS = 10000;

export type EvalDimensionInput = { id: string; name: string; weight: number; rubric: string };
export type EvalHardRequirementInput = { id: string; label: string; kind: string };

const AiScreeningResultSchema = z.object({
  coverage: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  dimensionScores: z.array(z.object({
    dimensionId: z.string(),
    evaluated: z.boolean(),
    score: z.number().min(0).max(100).nullable(),
    reason: z.string().max(500),
    evidenceQuote: z.string().max(400).nullable(),
  })),
  hardRequirementFindings: z.array(z.object({
    requirementId: z.string(),
    status: z.enum(['met', 'not_met', 'unknown']),
    reason: z.string().max(400),
    evidenceQuote: z.string().max(400).nullable(),
  })),
});
export type AiScreeningResult = z.infer<typeof AiScreeningResultSchema>;

const SYSTEM_PROMPT = `You are conducting a formal screening evaluation of one already-linked candidate against one job's confirmed rubric, for a hiring team's internal record.

Rules:
- Base every judgment strictly on the resume text provided. Never invent employers, dates, numbers, or quotes not verbatim in the text.
- evidenceQuote must be an exact short quote copied from the resume text, or null if you cannot find a real supporting quote -- never paraphrase and present it as a quote.
- score is on a 0-100 scale (not 0-10, not a percentage of 1) -- a strong dimension should score in the 80s-90s, a weak one below 40. Never emit single-digit scores for a genuinely strong match.
- A dimension is "evaluated": false only when the resume genuinely gives no basis to judge it (score and evidenceQuote must then be null) -- this is different from a low score, which is a real judgment.
- For hardRequirementFindings: "met" only with a real supporting quote; "not_met" only when the resume actively contradicts it or a required credential/authorization is stated absent; otherwise "unknown" (the resume simply doesn't say, which is not the same as failing it).
- coverage (0-1) is the fraction of dimensions you were able to evaluate (weighted by their weight), not an average score.
- confidence (0-1) reflects how solid the evidence is, independent of whether the candidate looks strong or weak.
- Respond with a single JSON object only, matching exactly this shape:
{
  "coverage": number,
  "confidence": number,
  "dimensionScores": [{ "dimensionId": string, "evaluated": boolean, "score": number 0-100 or null, "reason": string, "evidenceQuote": string|null }],
  "hardRequirementFindings": [{ "requirementId": string, "status": "met"|"not_met"|"unknown", "reason": string, "evidenceQuote": string|null }]
}
Include one entry in dimensionScores for every dimension given, and one entry in hardRequirementFindings for every requirement given, using their exact ids.`;

@Injectable()
export class AiScreeningEvaluatorService {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return isAiConfigured(this.config);
  }

  async evaluate(input: {
    jobTitle: string;
    dimensions: EvalDimensionInput[];
    hardRequirements: EvalHardRequirementInput[];
    resumeText: string;
  }): Promise<AiScreeningResult> {
    const dimensionsBlock = input.dimensions
      .map((d) => `- id=${d.id} | ${d.name} | weight=${d.weight} | rubric: ${d.rubric}`)
      .join('\n');
    const requirementsBlock = input.hardRequirements
      .map((r) => `- id=${r.id} | kind=${r.kind} | ${r.label}`)
      .join('\n');
    const prompt = `# Job
Title: ${input.jobTitle}

# Dimensions (score each using its own rubric)
${dimensionsBlock || '(none)'}

# Hard requirements (must-have; evaluate strictly)
${requirementsBlock || '(none)'}

# Candidate resume (verbatim, may be truncated)
${input.resumeText.slice(0, MAX_RESUME_CHARS)}`;
    return callAiForJson(this.config, SYSTEM_PROMPT, prompt, AiScreeningResultSchema);
  }
}
