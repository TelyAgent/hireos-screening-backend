import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export const importChannelSchema = z.enum(['manual_upload', 'email', 'folder', 'api']);

export const pasteCandidateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional().or(z.literal('')),
  location: z.string().trim().max(200).optional(),
  notes: z.string().max(5000).optional(),
}).strict();

export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({
      code: 'INVALID_INPUT',
      fieldErrors: parsed.error.flatten(),
    });
  }
  return parsed.data;
}
