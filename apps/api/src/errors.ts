import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';

// One error shape for every new API (REST and socket): { ok: false, code, reason }.
// `code` is stable for programs; `reason` is the Thai sentence the screens show. Phase 1 replies keep their `reason`
// and gain a `code`, so existing screens are unaffected.
// Errors never say whether a particular patient / HN exists (RESOURCE_NOT_FOUND also covers "not yours").
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  RESOURCE_NOT_FOUND: 404,
  SLOT_FULL_OR_CLOSED: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  INVALID_STATE_TRANSITION: 409,
  POLICY_REJECTED: 422,
  FEATURE_DISABLED: 403,
  RATE_LIMITED: 429,
  QUEUE_ENGINE_UNAVAILABLE: 503,
  UPSTREAM_UNAVAILABLE: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
export type Failure = { ok: false; code: ErrorCode; reason: string };

export const fail = (code: ErrorCode, reason: string): Failure => ({ ok: false, code, reason });

// Thrown inside services (also rolls back DbService.tx); REST routes turn it into the HTTP status, socket handlers into fail().
export class AppError extends Error {
  constructor(readonly code: ErrorCode, readonly reason: string) { super(reason); }
  get status() { return ERROR_STATUS[this.code]; }
  toJSON(): Failure { return fail(this.code, this.reason); }
}

@Catch(AppError)
export class AppErrorFilter implements ExceptionFilter {
  catch(err: AppError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<{ status: (n: number) => { json: (b: unknown) => void } }>();
    res.status(err.status).json(err.toJSON());
  }
}
