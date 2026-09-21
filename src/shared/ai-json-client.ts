import { ConfigService } from '@nestjs/config';
import type { ZodType } from 'zod';

// Shared by every feature that calls out to the configured AI provider for a structured
// JSON answer (job matching, resume parsing, ...). Keeping the HTTP/auth/error handling in
// one place means a fix here (like the reasoning-token budget issue below) covers every
// caller instead of needing to be rediscovered per feature.
export class AiCallError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

function aiBaseUrl(config: ConfigService): string {
  return config.get<string>('HIREOS_AI_BASE_URL', '').trim();
}

function aiApiKey(config: ConfigService): string {
  return config.get<string>('HIREOS_AI_API_KEY', '').trim();
}

function aiModel(config: ConfigService): string {
  return config.get<string>('HIREOS_AI_MODEL', '').trim();
}

function aiTimeoutMs(config: ConfigService): number {
  return Number(config.get<string>('HIREOS_AI_TIMEOUT_SECONDS', '60')) * 1000;
}

export function isAiConfigured(config: ConfigService): boolean {
  return Boolean(aiBaseUrl(config) && aiApiKey(config) && aiModel(config));
}

export async function callAiForJson<T>(
  config: ConfigService,
  systemPrompt: string,
  userPrompt: string,
  schema: ZodType<T>,
  opts?: { maxCompletionTokens?: number },
): Promise<T> {
  if (!isAiConfigured(config)) throw new AiCallError('AI_NOT_CONFIGURED');

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), aiTimeoutMs(config));
  let response: Response;
  try {
    response = await globalThis.fetch(`${aiBaseUrl(config).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${aiApiKey(config)}` },
      body: JSON.stringify({
        model: aiModel(config),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        // This model spends part of its completion budget on hidden reasoning tokens
        // before writing visible output -- at default effort, a full evaluation prompt
        // exhausted the whole budget on reasoning and returned empty content
        // (finish_reason: "length"). Capping effort keeps room for the actual answer.
        reasoning_effort: 'low',
        max_completion_tokens: opts?.maxCompletionTokens ?? 6000,
      }),
    });
  } catch (error) {
    throw new AiCallError(error instanceof Error ? error.message : 'AI_REQUEST_FAILED', error);
  } finally {
    globalThis.clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AiCallError(`AI_HTTP_${response.status}: ${text.slice(0, 300)}`);
  }

  const body = (await response.json().catch((error) => {
    throw new AiCallError('AI_INVALID_RESPONSE_BODY', error);
  })) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  const choice = body.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    // "length" here means the token budget ran out (often on hidden reasoning tokens)
    // before any visible content was written -- distinct from a genuinely empty reply.
    throw new AiCallError(choice?.finish_reason === 'length' ? 'AI_TRUNCATED_BEFORE_OUTPUT' : 'AI_EMPTY_RESPONSE');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new AiCallError('AI_INVALID_JSON', error);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new AiCallError(`AI_SCHEMA_MISMATCH: ${result.error.message}`);
  return result.data;
}
