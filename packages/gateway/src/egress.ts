import { GatewayError } from './errors.js';

export interface EgressOptions {
  /** Opt-in application-level origin restriction; not a network firewall. */
  restrictedEgress?: boolean;
  egressAllowedOrigins?: string[];
  /** Synthetic workstation fixtures only. Never enable in production. */
  allowInsecureLoopback?: boolean;
}

function parsedUrl(value: string, options: EgressOptions): URL {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new GatewayError('CONFIG_INVALID', 'Egress destination must be an absolute URL', 500);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && options.allowInsecureLoopback === true))) {
    throw new GatewayError('CONFIG_INVALID', 'Egress requires HTTPS without embedded credentials or fragments', 500);
  }
  return url;
}

export function validateEgressOptions(options: EgressOptions): void {
  if (options.restrictedEgress !== undefined && typeof options.restrictedEgress !== 'boolean') {
    throw new GatewayError('CONFIG_INVALID', 'restrictedEgress must be a boolean', 500);
  }
  if (options.allowInsecureLoopback !== undefined && typeof options.allowInsecureLoopback !== 'boolean') {
    throw new GatewayError('CONFIG_INVALID', 'allowInsecureLoopback must be a boolean', 500);
  }
  if (options.allowInsecureLoopback === true && process.env['NODE_ENV'] === 'production') {
    throw new GatewayError('CONFIG_INVALID', 'Insecure loopback fixtures are forbidden in production', 500);
  }
  if (!options.restrictedEgress) return;
  if (!Array.isArray(options.egressAllowedOrigins) || options.egressAllowedOrigins.length === 0
    || options.egressAllowedOrigins.length > 32) {
    throw new GatewayError('CONFIG_INVALID', 'restrictedEgress requires 1 to 32 exact egressAllowedOrigins', 500);
  }
  for (const value of options.egressAllowedOrigins) {
    if (typeof value !== 'string') throw new GatewayError('CONFIG_INVALID', 'Egress origins must be strings', 500);
    const url = parsedUrl(value, options);
    if (url.pathname !== '/' || url.search || value.includes('*')) {
      throw new GatewayError('CONFIG_INVALID', 'Egress allowlist entries must be exact origins, not paths or wildcards', 500);
    }
  }
}

export function assertEgressDestination(value: string, options: EgressOptions): void {
  validateEgressOptions(options);
  if (!options.restrictedEgress) return;
  const target = parsedUrl(value, options);
  if (!options.egressAllowedOrigins!.some((origin) => new URL(origin).origin === target.origin)) {
    throw new GatewayError('EGRESS_DENIED', 'Destination is outside the configured origin allowlist', 403);
  }
}
