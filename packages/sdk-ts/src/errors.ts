export class GrantexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantexError';
    // Restore prototype chain (required for instanceof checks in ES5 targets)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class GrantexApiError extends GrantexError {
  readonly statusCode: number;
  readonly body: unknown;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    statusCode: number,
    body: unknown,
    requestId?: string,
  ) {
    super(message);
    this.name = 'GrantexApiError';
    this.statusCode = statusCode;
    this.body = body;
    this.requestId = requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class GrantexAuthError extends GrantexApiError {
  constructor(
    message: string,
    statusCode: 401 | 403,
    body: unknown,
    requestId?: string,
  ) {
    super(message, statusCode, body, requestId);
    this.name = 'GrantexAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class GrantexTokenError extends GrantexError {
  constructor(message: string) {
    super(message);
    this.name = 'GrantexTokenError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class GrantexNetworkError extends GrantexError {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GrantexNetworkError';
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
