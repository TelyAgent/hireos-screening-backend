import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { callAiForJson, isAiConfigured } from '../shared/ai-json-client';

const MAX_RESUME_CHARS = 10000;

const StatusField = z.object({ value: z.string(), status: z.enum(['known', 'unknown']) });

const AiProfileSchema = z.object({
  displayName: z.string().min(1).max(200),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  location: StatusField,
  workAuthorization: StatusField,
  skills: z.array(z.string().max(80)).max(40),
  languages: z.array(z.string().max(40)).max(15),
  employmentHistory: z.array(z.object({
    company: z.string().max(200),
    title: z.string().max(200),
    start: z.string().max(40),
    end: z.string().max(40),
    achievements: z.array(z.string().max(400)).max(10),
  })).max(15),
  education: z.array(z.object({
    statement: z.string().max(300),
    period: z.string().max(60),
  })).max(10),
  certifications: z.array(z.string().max(200)).max(15),
  projects: z.array(z.object({ name: z.string().max(200), description: z.string().max(400) })).max(10),
  compensationExpectation: z.object({
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
    currency: z.string().max(10),
    period: z.enum(['year', 'month', 'hour']),
    basis: z.enum(['gross', 'net', 'unknown']),
  }).nullable(),
});
export type AiParsedProfile = z.infer<typeof AiProfileSchema>;

const SYSTEM_PROMPT = `You are extracting a structured candidate profile from one resume for an applicant tracking system.

Rules:
- Base every field strictly on the resume text. Never invent employers, dates, numbers, or skills not present in the text.
- A field you cannot find must be its empty/null form (empty string, empty array, or null) -- never guess or fill in a plausible-looking placeholder.
- location and workAuthorization: status "known" only if the resume states it explicitly or it is directly inferable (e.g. a city name next to contact info counts as a known location); otherwise status "unknown" with an empty value.
- skills: list concrete skills/tools/technologies actually named in the resume, in the language they appear in (do not translate). Do not invent a canonical list -- extract what's there, including non-technical skills (e.g. "预算管理", "供应商管理") for non-engineering resumes.
- employmentHistory: one entry per job, most recent first, achievements as short bullet-style strings (not full paragraphs).
- compensationExpectation: parse a stated salary expectation into normalized numbers. A Chinese resume figure like "35-45K" means monthly salary in thousands of the local currency (e.g. 35-45K -> min 35000, max 45000, currency "CNY", period "month"). A trailing "N 薪" (N months of pay per year) does not change the monthly figures -- ignore it for min/max, it is not part of this schema. If no salary expectation is stated anywhere, this field must be null, not a guess.
- Respond with a single JSON object only, matching exactly this shape:
{
  "displayName": string,
  "email": string | null,
  "phone": string | null,
  "location": { "value": string, "status": "known" | "unknown" },
  "workAuthorization": { "value": string, "status": "known" | "unknown" },
  "skills": [string],
  "languages": [string],
  "employmentHistory": [{ "company": string, "title": string, "start": string, "end": string, "achievements": [string] }],
  "education": [{ "statement": string, "period": string }],
  "certifications": [string],
  "projects": [{ "name": string, "description": string }],
  "compensationExpectation": { "min": number, "max": number, "currency": string, "period": "year"|"month"|"hour", "basis": "gross"|"net"|"unknown" } | null
}`;

@Injectable()
export class AiProfileParserService {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return isAiConfigured(this.config);
  }

  async parse(resumeText: string, fallbackName: string): Promise<AiParsedProfile> {
    const prompt = `# Fallback name (use only if the resume has no name)
${fallbackName}

# Resume (verbatim, may be truncated)
${resumeText.slice(0, MAX_RESUME_CHARS)}`;
    return callAiForJson(this.config, SYSTEM_PROMPT, prompt, AiProfileSchema);
  }
}
