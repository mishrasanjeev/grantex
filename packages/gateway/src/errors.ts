export type GatewayErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'ROUTE_NOT_FOUND'
  | 'TOKEN_MISSING'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'AUDIENCE_UNCONFIGURED'
  | 'AUDIENCE_MISMATCH'
  | 'REGION_UNCONFIGURED'
  | 'REGION_MISMATCH'
  | 'SCOPE_INSUFFICIENT'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'PATH_INVALID'
  | 'CREDENTIAL_REF_INVALID'
  | 'CREDENTIAL_RESOLVE_FAILED';

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly statusCode: number;

  constructor(code: GatewayErrorCode, message: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, GatewayError.prototype);
  }
}
