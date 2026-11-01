import type { z } from 'zod';
import { InvalidPayloadError } from '../application/errors';

export function parseWith<Schema extends z.ZodType>(schema: Schema, input: unknown): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new InvalidPayloadError(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
