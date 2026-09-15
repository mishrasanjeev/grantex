import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** SHA-256, base64url: how browser-binding secrets are stored. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/** Constant-time check of a presented secret against a stored SHA-256. */
export function hashesMatch(expectedHash: unknown, presented: unknown): boolean {
  if (typeof expectedHash !== 'string' || expectedHash.length === 0) return false;
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 256) return false;
  const a = Buffer.from(expectedHash);
  const b = Buffer.from(sha256(presented));
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface CookieScope {
  /** The issuer URL; https issuers get `__Host-` cookies with `Secure`. */
  issuer: string;
}

function secure(scope: CookieScope): boolean {
  return new URL(scope.issuer).protocol === 'https:';
}

/**
 * A per-flow cookie name: `<kind>_<first 16 chars of sha256(id)>`, prefixed
 * `__Host-` on https so it is pinned to this exact host and path `/`.
 */
export function bindingCookieName(scope: CookieScope, kind: string, id: string): string {
  const base = `mcp_auth_${kind}_${sha256(id).slice(0, 16)}`;
  return secure(scope) ? `__Host-${base}` : base;
}

export function bindingCookie(
  scope: CookieScope,
  name: string,
  value: string,
  maxAgeSeconds: number,
  sameSite: 'Strict' | 'Lax',
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Max-Age=${maxAgeSeconds}`,
    ...(secure(scope) ? ['Secure'] : []),
  ].join('; ');
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** Appends a Set-Cookie header, keeping any already set on the reply. */
export function appendCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader('set-cookie');
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  reply.header('set-cookie', [...list, cookie]);
}
