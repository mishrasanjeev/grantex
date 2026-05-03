import net from 'node:net';

export interface OutboundUrlPolicy {
  allowedProtocols: readonly string[];
  allowInsecureHttp?: boolean;
  allowPrivateHosts?: boolean;
}

const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
]);

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = parseIpv4(hostname);
  if (!octets) return false;
  const a = octets[0]!;
  const b = octets[1]!;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127)
    || a === 0;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    const dotted = parseIpv4(mapped);
    if (dotted) return isPrivateIpv4(mapped);

    const words = mapped.split(':').map((part) => parseInt(part, 16));
    if (words.length === 2 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)) {
      const ipv4 = [
        words[0]! >> 8,
        words[0]! & 0xff,
        words[1]! >> 8,
        words[1]! & 0xff,
      ].join('.');
      return isPrivateIpv4(ipv4);
    }
  }
  // Link-local is fe80::/10 — first 10 bits 1111111010, i.e. first 16-bit
  // group ranges 0xfe80–0xfebf. Matching only "fe80:" missed fe81:..febf:
  // (e.g. fe90::1), leaving an SSRF path to link-local targets.
  return normalized === '::1'
    || normalized.startsWith('fc')        // fc00::/7 unique-local (low half)
    || normalized.startsWith('fd')        // fc00::/7 unique-local (high half)
    || /^fe[89ab][0-9a-f]:/.test(normalized)  // fe80::/10 link-local
    || normalized === '::';
}

export function isBlockedPrivateHost(hostname: string): boolean {
  // Strip surrounding [] (IPv6 literals) and any trailing dots before
  // comparing — a trailing dot makes a hostname an absolute FQDN that DNS
  // resolves identically (e.g. "localhost." === "localhost"), so without
  // stripping it the loopback/private guards can be bypassed.
  const normalized = hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (LOCAL_HOSTNAMES.has(normalized) || normalized.endsWith('.localhost')) return true;
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) return isPrivateIpv6(normalized);
  return false;
}

/**
 * Validate an outbound URL string against the supplied policy.
 *
 * Known limitation: this validator inspects the URL string only. It does
 * not resolve DNS, so an attacker-controlled hostname like
 * `attacker.example` whose A record points to 127.0.0.1 / RFC1918 space
 * will pass even when `allowPrivateHosts` is false. Full SSRF defense
 * requires resolving the hostname once and pinning the connection to the
 * resolved IP, which is tracked in #313 (DNS-pinned outbound fetch).
 *
 * Until that lands, this function is still a meaningful defense-in-depth
 * layer: it blocks literal private IPs, localhost variants, IPv6
 * link-local (fe80::/10), embedded credentials, and disallowed protocols.
 */
export function validateOutboundUrl(value: string, policy: OutboundUrlPolicy): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error('URL is required and must be 2048 characters or fewer');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('URL must be absolute and valid');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URL must not contain embedded credentials');
  }

  if (!parsed.hostname) {
    // URLs like "ldap:///dc=example" parse cleanly with an empty hostname,
    // and downstream callers (LDAP socket open, fetch) end up with ambiguous
    // or default-target behavior instead of a deterministic rejection.
    throw new Error('URL must include a hostname');
  }

  if (!policy.allowedProtocols.includes(parsed.protocol)) {
    throw new Error(`URL protocol must be one of: ${policy.allowedProtocols.join(', ')}`);
  }

  if (parsed.protocol === 'http:' && !policy.allowInsecureHttp) {
    throw new Error('HTTP URLs are disabled; use HTTPS');
  }

  if (!policy.allowPrivateHosts && isBlockedPrivateHost(parsed.hostname)) {
    throw new Error('Private, loopback, and link-local hosts are not allowed');
  }

  return parsed;
}

export function assertValidRedirectUri(value: string): void {
  validateOutboundUrl(value, {
    allowedProtocols: ['https:', 'http:'],
    allowInsecureHttp: process.env.NODE_ENV !== 'production',
    allowPrivateHosts: process.env.NODE_ENV !== 'production',
  });
}
