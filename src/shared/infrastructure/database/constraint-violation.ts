import { UniqueConstraintViolationException } from '@mikro-orm/core';

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof UniqueConstraintViolationException &&
    (error as UniqueConstraintViolationException & { constraint?: string }).constraint === constraint
  );
}
