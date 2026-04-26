/** Thrown from job processors; worker maps this to BullMQ `UnrecoverableError` (no further retries). */
export class JobUnrecoverableError extends Error {
  readonly code = "queuehouse_unrecoverable" as const;
  override readonly name = "JobUnrecoverableError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isJobUnrecoverableError(e: unknown): e is JobUnrecoverableError {
  return e instanceof JobUnrecoverableError;
}
