// Typed application errors. HTTP layers map these to their own wire formats:
// the v1 machine API uses {error, message}; the admin API uses {error:{code,message,details}}.

export type AppErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'precondition_failed'
  | 'rate_limited'
  | 'validation_failed'
  | 'protocol_incompatible'
  | 'provider_unavailable'
  | 'internal';

const STATUS: Record<AppErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  rate_limited: 429,
  validation_failed: 422,
  protocol_incompatible: 422,
  provider_unavailable: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`);
export const conflict = (msg: string, details?: unknown) => new AppError('conflict', msg, details);
export const invalid = (msg: string, details?: unknown) => new AppError('validation_failed', msg, details);
export const forbidden = (msg = 'You do not have permission to perform this action') => new AppError('forbidden', msg);
