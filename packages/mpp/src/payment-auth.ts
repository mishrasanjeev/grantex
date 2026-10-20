/**
 * The "Payment" HTTP authentication scheme (draft-ryan-httpauth-payment-01),
 * the HTTP 402 flow MPP runs on:
 *
 *   1. The server answers a request that needs payment with 402 and
 *      `WWW-Authenticate: Payment id="…", realm="…", method="…",
 *      intent="…", request="<base64url JCS>"[, expires, digest,
 *      description, opaque]` (section 5.1), one challenge per method or
 *      intent.
 *   2. The client retries with `Authorization: Payment <base64url JSON>`
 *      whose JSON is `{challenge: {…echoed…}, source?, payload}` (section
 *      5.2): the payment method's own proof travels in `payload`.
 *   3. The server verifies the credential and, on success, answers 2xx with
 *      `Payment-Receipt: <base64url JSON {status: "success", method,
 *      timestamp, reference}>` (section 5.3).
 *
 * The challenge id is bound to its parameters statelessly as section
 * 5.1.2.1.1 recommends: base64url(HMAC-SHA256(server_secret,
 * realm|method|intent|request|expires|digest|opaque)), every slot present,
 * an absent one empty. Errors are RFC 9457 problem details under
 * `https://paymentauth.org/problems/` (section 8).
 *
 * Note: there is no `Payment-Signature` header in this scheme. That name
 * belongs to x402 v2 (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` /
 * `PAYMENT-RESPONSE`), which `@grantex/x402` implements.
 *
 * Grantex verifies the challenge binding, expiry, realm, method and body
 * digest; the payment method's proof (`payload`) is verified by the
 * integrator's method verifier. Grantex settles nothing.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const PAYMENT_AUTH_SCHEME = 'Payment';
export const PAYMENT_RECEIPT_HEADER = 'Payment-Receipt';
export const PAYMENT_PROBLEM_BASE = 'https://paymentauth.org/problems/';

/** Section 8. */
export const PAYMENT_PROBLEMS = {
  'payment-required': { status: 402, title: 'Payment required' },
  'payment-insufficient': { status: 402, title: 'Payment insufficient' },
  'payment-expired': { status: 402, title: 'Payment expired' },
  'verification-failed': { status: 402, title: 'Payment verification failed' },
  'method-unsupported': { status: 400, title: 'Payment method unsupported' },
  'malformed-credential': { status: 402, title: 'Malformed payment credential' },
  'invalid-challenge': { status: 402, title: 'Invalid payment challenge' },
} as const;
export type PaymentProblemCode = keyof typeof PAYMENT_PROBLEMS;

export interface PaymentProblem {
  type: string;
  title: string;
  status: number;
  detail: string;
}

/** RFC 9457 problem details for a section 8 code. */
export function paymentProblem(code: PaymentProblemCode, detail: string): PaymentProblem {
  const p = PAYMENT_PROBLEMS[code];
  return { type: `${PAYMENT_PROBLEM_BASE}${code}`, title: p.title, status: p.status, detail };
}

/** The auth-params of one challenge, as sent and as echoed in the credential. */
export interface PaymentChallenge {
  id: string;
  realm: string;
  /** Lowercase payment-method identifier. */
  method: string;
  /** A registered payment intent, e.g. `charge` or `authorize`. */
  intent: string;
  /** base64url (no padding) of the JCS-serialized method request data. */
  request: string;
  /** RFC 3339. */
  expires?: string;
  /** RFC 9530 digest of the body the client must resend. */
  digest?: string;
  description?: string;
  /** base64url of the JCS of a flat string map, echoed unchanged. */
  opaque?: string;
}

const METHOD = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const B64URL = /^[A-Za-z0-9_-]*$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class PaymentAuthError extends Error {
  constructor(readonly code: PaymentProblemCode, message: string) {
    super(message);
    this.name = 'PaymentAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** RFC 8785 JCS for the JSON this scheme serializes (no floats needed, but ES serialization is used). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PaymentAuthError('malformed-credential', 'non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new PaymentAuthError('malformed-credential', `no JSON form for ${typeof value}`);
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

function decodeB64urlJson(value: string, what: string): unknown {
  if (!B64URL.test(value) || value.length === 0) throw new PaymentAuthError('malformed-credential', `${what} is not base64url`);
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new PaymentAuthError('malformed-credential', `${what} is not base64url JSON`);
  }
}

/** Section 5.1.2.1.1: the stateless challenge id. */
export function paymentChallengeId(secret: string | Buffer, c: Omit<PaymentChallenge, 'id'>): string {
  const input = [c.realm, c.method, c.intent, c.request, c.expires ?? '', c.digest ?? '', c.opaque ?? ''].join('|');
  return createHmac('sha256', secret).update(input, 'utf8').digest('base64url');
}

/** RFC 9530 sha-256 digest of a body, as the `digest` parameter carries it. */
export function bodyDigest(body: string | Uint8Array): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

export interface CreateChallengeOptions {
  secret: string | Buffer;
  realm: string;
  method: string;
  intent: string;
  /** Method request data; serialized with JCS and base64url-encoded. */
  request: Record<string, unknown>;
  /** Seconds from now, or an explicit RFC 3339 time. */
  expiresIn?: number;
  expires?: string;
  /** Bind the challenge to the body the client must resend. */
  body?: string | Uint8Array;
  description?: string;
  opaque?: Record<string, string>;
  now?: Date;
}

/** A challenge with its id bound to its parameters. */
export function createPaymentChallenge(options: CreateChallengeOptions): PaymentChallenge {
  if (!METHOD.test(options.method)) throw new PaymentAuthError('method-unsupported', 'method must be a lowercase payment method id');
  if (!TOKEN.test(options.intent)) throw new PaymentAuthError('invalid-challenge', 'intent must be a token');
  if (options.realm.length === 0) throw new PaymentAuthError('invalid-challenge', 'realm is required');
  const expires = options.expires
    ?? (options.expiresIn !== undefined ? new Date((options.now ?? new Date()).getTime() + options.expiresIn * 1000).toISOString() : undefined);
  if (expires !== undefined && !RFC3339.test(expires)) throw new PaymentAuthError('invalid-challenge', 'expires must be RFC 3339');
  if (options.opaque !== undefined && Object.values(options.opaque).some((v) => typeof v !== 'string')) {
    throw new PaymentAuthError('invalid-challenge', 'opaque is a flat map of strings');
  }
  const unsigned: Omit<PaymentChallenge, 'id'> = {
    realm: options.realm,
    method: options.method,
    intent: options.intent,
    request: b64url(canonicalJson(options.request)),
    ...(expires !== undefined ? { expires } : {}),
    ...(options.body !== undefined ? { digest: bodyDigest(options.body) } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.opaque !== undefined ? { opaque: b64url(canonicalJson(options.opaque)) } : {}),
  };
  return { id: paymentChallengeId(options.secret, unsigned), ...unsigned };
}

function quote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new PaymentAuthError('invalid-challenge', 'a parameter has a control character');
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

const PARAM_ORDER = ['id', 'realm', 'method', 'intent', 'request', 'expires', 'digest', 'description', 'opaque'] as const;

/** One `WWW-Authenticate` challenge: `Payment id="…", realm="…", …`. */
export function formatPaymentChallenge(challenge: PaymentChallenge): string {
  const params = PARAM_ORDER
    .filter((name) => challenge[name] !== undefined)
    .map((name) => `${name}=${quote(challenge[name] as string)}`);
  return `${PAYMENT_AUTH_SCHEME} ${params.join(', ')}`;
}

/**
 * Every `Payment` challenge of a WWW-Authenticate field value (RFC 9110
 * section 11.6.1: challenges and auth-params are comma-separated; a token
 * not followed by `=` starts a new challenge). Challenges of other schemes
 * are skipped; unknown parameters are ignored (section 5.1).
 */
export function parsePaymentChallenges(value: string): PaymentChallenge[] {
  const out: PaymentChallenge[] = [];
  let i = 0;
  const n = value.length;
  const ws = () => { while (i < n && (value[i] === ' ' || value[i] === '\t' || value[i] === ',')) i++; };
  const token = () => {
    const start = i;
    while (i < n && /[!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(value[i]!)) i++;
    return value.slice(start, i);
  };
  let current: { scheme: string; params: Record<string, string> } | null = null;
  const flush = () => {
    if (current && current.scheme.toLowerCase() === 'payment') {
      const p = current.params;
      if (p['id'] && p['realm'] && p['method'] && p['intent'] && p['request'] !== undefined) {
        out.push({
          id: p['id'], realm: p['realm'], method: p['method'], intent: p['intent'], request: p['request'],
          ...(p['expires'] !== undefined ? { expires: p['expires'] } : {}),
          ...(p['digest'] !== undefined ? { digest: p['digest'] } : {}),
          ...(p['description'] !== undefined ? { description: p['description'] } : {}),
          ...(p['opaque'] !== undefined ? { opaque: p['opaque'] } : {}),
        });
      }
    }
  };
  while (i < n) {
    ws();
    if (i >= n) break;
    const name = token();
    if (name === '') throw new PaymentAuthError('invalid-challenge', 'malformed WWW-Authenticate');
    let j = i;
    while (j < n && (value[j] === ' ' || value[j] === '\t')) j++;
    if (value[j] === '=') {
      if (current === null) throw new PaymentAuthError('invalid-challenge', 'an auth-param before any scheme');
      i = j + 1;
      while (i < n && (value[i] === ' ' || value[i] === '\t')) i++;
      let v: string;
      if (value[i] === '"') {
        i++;
        let s = '';
        while (i < n && value[i] !== '"') {
          if (value[i] === '\\' && i + 1 < n) i++;
          s += value[i];
          i++;
        }
        if (value[i] !== '"') throw new PaymentAuthError('invalid-challenge', 'unterminated quoted-string');
        i++;
        v = s;
      } else {
        v = token();
      }
      current.params[name.toLowerCase()] = v;
    } else {
      flush();
      current = { scheme: name, params: {} };
      i = j;
      // A token68 credential-style value after a scheme is not used by Payment challenges; skip it.
      if (/[A-Za-z0-9\-._~+/]/.test(value[i] ?? '') && !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=/.test(value.slice(i))) {
        while (i < n && value[i] !== ',') i++;
      }
    }
  }
  flush();
  return out;
}

export interface PaymentCredential {
  challenge: PaymentChallenge;
  /** Payer identifier; a DID is RECOMMENDED. */
  source?: string;
  /** The payment method's own proof. */
  payload: unknown;
}

/** `Payment <base64url JSON>` for the Authorization field (section 5.2). */
export function formatPaymentCredential(credential: PaymentCredential): string {
  return `${PAYMENT_AUTH_SCHEME} ${b64url(JSON.stringify(credential))}`;
}

/** Reads `Authorization: Payment <base64url JSON>`. */
export function parsePaymentCredential(authorization: string | undefined | null): PaymentCredential {
  if (typeof authorization !== 'string') throw new PaymentAuthError('payment-required', 'no Payment credential');
  const m = /^Payment\s+([A-Za-z0-9_-]+)\s*$/i.exec(authorization.trim());
  if (!m) throw new PaymentAuthError('malformed-credential', 'Authorization is not a Payment credential');
  const json = decodeB64urlJson(m[1]!, 'the credential');
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new PaymentAuthError('malformed-credential', 'the credential is not an object');
  const c = (json as Record<string, unknown>)['challenge'];
  if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new PaymentAuthError('malformed-credential', 'the credential has no challenge');
  const ch = c as Record<string, unknown>;
  for (const name of ['id', 'realm', 'method', 'intent', 'request'] as const) {
    if (typeof ch[name] !== 'string') throw new PaymentAuthError('malformed-credential', `challenge.${name} is missing`);
  }
  for (const name of ['expires', 'digest', 'description', 'opaque'] as const) {
    if (ch[name] !== undefined && typeof ch[name] !== 'string') throw new PaymentAuthError('malformed-credential', `challenge.${name} is not a string`);
  }
  if (!('payload' in (json as Record<string, unknown>))) throw new PaymentAuthError('malformed-credential', 'the credential has no payload');
  const source = (json as Record<string, unknown>)['source'];
  if (source !== undefined && typeof source !== 'string') throw new PaymentAuthError('malformed-credential', 'source is not a string');
  return {
    challenge: Object.fromEntries(PARAM_ORDER.filter((k) => ch[k] !== undefined).map((k) => [k, ch[k]])) as unknown as PaymentChallenge,
    ...(source !== undefined ? { source } : {}),
    payload: (json as Record<string, unknown>)['payload'],
  };
}

export interface VerifyCredentialOptions {
  secret: string | Buffer;
  realm: string;
  /** The methods this server accepts. */
  methods: readonly string[];
  /** The request body, required when the challenge carries `digest`. */
  body?: string | Uint8Array;
  now?: Date;
}

/**
 * Checks the echoed challenge: the id is this server's binding of exactly
 * these parameters, the realm and method are this server's, it has not
 * expired, and a bound body matches. Throws a PaymentAuthError with the
 * section 8 code; the method's proof (`payload`) is the caller's to verify.
 */
export function verifyPaymentCredential(credential: PaymentCredential, options: VerifyCredentialOptions): PaymentCredential {
  const c = credential.challenge;
  const { id, ...unsigned } = c;
  const expected = paymentChallengeId(options.secret, unsigned);
  const a = Buffer.from(id);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new PaymentAuthError('invalid-challenge', 'the challenge was not issued by this server with these parameters');
  if (c.realm !== options.realm) throw new PaymentAuthError('invalid-challenge', 'the challenge is for another realm');
  if (!options.methods.includes(c.method)) throw new PaymentAuthError('method-unsupported', `method ${c.method} is not accepted here`);
  if (c.expires !== undefined) {
    const at = Date.parse(c.expires);
    if (Number.isNaN(at)) throw new PaymentAuthError('invalid-challenge', 'expires is not a time');
    if ((options.now ?? new Date()).getTime() >= at) throw new PaymentAuthError('payment-expired', 'the challenge has expired');
  }
  if (c.digest !== undefined) {
    if (options.body === undefined || bodyDigest(options.body) !== c.digest) {
      throw new PaymentAuthError('verification-failed', 'the request body does not match the challenge digest');
    }
  }
  return credential;
}

/** The method request data a challenge carries. */
export function decodeChallengeRequest(challenge: PaymentChallenge): unknown {
  return decodeB64urlJson(challenge.request, 'request');
}

export interface PaymentReceipt {
  status: 'success';
  method: string;
  /** RFC 3339. */
  timestamp: string;
  reference: string;
}

/** `Payment-Receipt` value (section 5.3): base64url JSON, sent on 2xx only. */
export function formatPaymentReceipt(receipt: Omit<PaymentReceipt, 'status' | 'timestamp'> & { timestamp?: string }): string {
  const value: PaymentReceipt = {
    status: 'success',
    method: receipt.method,
    timestamp: receipt.timestamp ?? new Date().toISOString(),
    reference: receipt.reference,
  };
  return b64url(JSON.stringify(value));
}

export function parsePaymentReceipt(value: string): PaymentReceipt {
  const json = decodeB64urlJson(value.trim(), 'Payment-Receipt') as Record<string, unknown> | null;
  if (!json || json['status'] !== 'success' || typeof json['method'] !== 'string'
      || typeof json['timestamp'] !== 'string' || typeof json['reference'] !== 'string') {
    throw new PaymentAuthError('malformed-credential', 'Payment-Receipt is not {status: success, method, timestamp, reference}');
  }
  return { status: 'success', method: json['method'], timestamp: json['timestamp'], reference: json['reference'] };
}

// ─── Express middleware ──────────────────────────────────────────────────────


export interface PaymentOffer {
  method: string;
  intent: string;
  request: Record<string, unknown>;
  description?: string;
  opaque?: Record<string, string>;
}

export interface RequirePaymentOptions {
  secret: string | Buffer;
  realm: string;
  /** The challenges to offer for this request, one per method or intent. */
  offers: (req: Request) => PaymentOffer[] | Promise<PaymentOffer[]>;
  /** Seconds a challenge stays valid. Defaults to 300. */
  expiresIn?: number;
  /** Bind each challenge to the request body (the `digest` parameter). Needs a raw body on `req.body`. */
  bindBody?: boolean;
  /**
   * Verifies the payment method's proof and returns the receipt reference.
   * Throw a PaymentAuthError (`verification-failed`, `payment-insufficient`)
   * to refuse. Grantex settles nothing; this is the method's verifier.
   */
  verifyPayload: (credential: PaymentCredential, req: Request) => Promise<{ reference: string }> | { reference: string };
}

export interface VerifiedPayment {
  credential: PaymentCredential;
  receipt: PaymentReceipt;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      payment?: VerifiedPayment;
    }
  }
}

function rawBody(req: Request): string | Uint8Array | undefined {
  const body: unknown = req.body;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  return undefined;
}

/**
 * Express middleware for the 402 flow: no credential answers 402 with the
 * challenges; a credential is checked (binding, realm, method, expiry,
 * digest) and handed to `verifyPayload`; success sets `Payment-Receipt` and
 * `req.payment`. Refusals are RFC 9457 problem details with fresh challenges.
 */
export function requirePayment(options: RequirePaymentOptions): RequestHandler {
  const expiresIn = options.expiresIn ?? 300;
  const challenge = async (req: Request, res: Response, problem: PaymentProblem) => {
    const offers = await options.offers(req);
    const body = options.bindBody ? rawBody(req) : undefined;
    const values = offers.map((offer) => formatPaymentChallenge(createPaymentChallenge({
      secret: options.secret,
      realm: options.realm,
      method: offer.method,
      intent: offer.intent,
      request: offer.request,
      expiresIn,
      ...(body !== undefined ? { body } : {}),
      ...(offer.description !== undefined ? { description: offer.description } : {}),
      ...(offer.opaque !== undefined ? { opaque: offer.opaque } : {}),
    })));
    res.status(problem.status);
    if (problem.status === 402) res.setHeader('WWW-Authenticate', values);
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/problem+json').send(JSON.stringify(problem));
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      if (header === undefined || !/^Payment\s/i.test(header)) {
        await challenge(req, res, paymentProblem('payment-required', 'This resource requires payment'));
        return;
      }
      let credential: PaymentCredential;
      try {
        credential = parsePaymentCredential(header);
        const methods = (await options.offers(req)).map((o) => o.method);
        const body = rawBody(req);
        verifyPaymentCredential(credential, {
          secret: options.secret,
          realm: options.realm,
          methods,
          ...(body !== undefined ? { body } : {}),
        });
        const { reference } = await options.verifyPayload(credential, req);
        const receiptValue = formatPaymentReceipt({ method: credential.challenge.method, reference });
        req.payment = { credential, receipt: parsePaymentReceipt(receiptValue) };
        res.setHeader(PAYMENT_RECEIPT_HEADER, receiptValue);
      } catch (error) {
        if (error instanceof PaymentAuthError) {
          await challenge(req, res, paymentProblem(error.code, error.message));
          return;
        }
        throw error;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
