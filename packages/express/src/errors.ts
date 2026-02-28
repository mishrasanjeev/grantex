import type { GrantexExpressErrorCode, GrantexExpressError } from './types.js';

export class GrantexMiddlewareError extends Error implements GrantexExpressError {
  readonly code: GrantexExpressErrorCode;
  readonly statusCode: number;

  constructor(code: GrantexExpressErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'GrantexMiddlewareError';
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
