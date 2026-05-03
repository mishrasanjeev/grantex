import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Spec §16 standard error envelope for commerce routes only. Distinct from
 * the platform-wide envelope ({ message, code, requestId }) on non-commerce
 * routes; that envelope stays untouched.
 */
export interface CommerceErrorBody {
  error: {
    code: string;
    message: string;
    decision_id?: string;
    audit_event_id?: string;
    remediation?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

export interface CommerceErrorOptions {
  decisionId?: string;
  auditEventId?: string;
  remediation?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class CommerceHttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly options: CommerceErrorOptions;

  constructor(statusCode: number, code: string, message: string, options: CommerceErrorOptions = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.options = options;
  }
}

export function commerceErrorEnvelope(
  code: string,
  message: string,
  options: CommerceErrorOptions = {},
): CommerceErrorBody {
  const error: CommerceErrorBody['error'] = { code, message };
  if (options.decisionId !== undefined) error.decision_id = options.decisionId;
  if (options.auditEventId !== undefined) error.audit_event_id = options.auditEventId;
  if (options.remediation !== undefined) error.remediation = options.remediation;
  if (options.retryable !== undefined) error.retryable = options.retryable;
  if (options.details !== undefined) error.details = options.details;
  return { error };
}

export async function sendCommerceError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  options: CommerceErrorOptions = {},
): Promise<FastifyReply> {
  return reply.status(statusCode).send(commerceErrorEnvelope(code, message, options));
}

/**
 * Scoped error handler — registered on the commerce sub-instance only via
 * `app.setErrorHandler`. Translates thrown CommerceHttpError into the
 * spec envelope; falls back to a 500 envelope for unexpected errors so
 * commerce routes never leak the platform envelope shape.
 */
export function commerceErrorHandler(
  err: Error & { statusCode?: number; code?: string; validation?: unknown },
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof CommerceHttpError) {
    void reply.status(err.statusCode).send(commerceErrorEnvelope(err.code, err.message, err.options));
    return;
  }
  // Fastify validation error
  if (err.validation) {
    void reply.status(422).send(commerceErrorEnvelope(
      'validation_failed',
      err.message || 'Request validation failed',
      { details: { fields: err.validation }, retryable: false },
    ));
    return;
  }
  // Unhandled — log at error level, return generic envelope.
  request.log.error({ err, requestId: request.id }, 'Unhandled commerce route error');
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  void reply.status(status).send(commerceErrorEnvelope(
    status >= 500 ? 'internal_error' : 'bad_request',
    status >= 500 ? 'An unexpected error occurred' : (err.message || 'Bad request'),
    { retryable: status >= 500 },
  ));
}
