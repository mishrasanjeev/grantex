/**
 * Minimal dependency-free LDAP bind support.
 *
 * The default client verifies the configured service account, constructs a
 * user DN from a deliberately restricted template such as
 * `(uid={{username}})`, and performs a user bind. It does not implement LDAP
 * directory searches, attribute lookup, or group membership lookup. Deployments
 * that need those features must inject a full LdapClient implementation.
 */

import type { Socket } from 'node:net';
import { config as appConfig } from '../config.js';
import { safeConnect, validateOutboundUrl } from './url-security.js';

export interface LdapConfig {
  ldapUrl: string;
  bindDn: string;
  bindPassword: string;
  searchBase: string;
  /**
   * Default-client user-DN template. Only a simple equality form such as
   * "(uid={{username}})" or "(sAMAccountName={{username}})" is supported.
   * Compound, wildcard, and arbitrary LDAP search filters are rejected.
   */
  searchFilter: string;
  /** Reserved for injected clients; the default client returns no groups. */
  groupSearchBase?: string;
  /** Reserved for injected clients; the default client returns no groups. */
  groupSearchFilter?: string;
  tlsEnabled: boolean;
}

export interface LdapUserInfo {
  dn: string;
  uid: string;
  email?: string;
  displayName?: string;
  groups: string[];
}

// RFC 4515 § 3 utility for injected clients that perform real LDAP searches.
// The dependency-free default client does not execute search filters.
export function escapeLdapFilter(value: string): string {
  return value
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

/** RFC 4514 escaping for a single DN attribute value. */
const LDAP_DN_BACKSLASH = '\\';

export function escapeLdapDnValue(value: string): string {
  const characters = Array.from(value);
  return characters.map((character, index) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      return Array.from(Buffer.from(character, 'utf8'))
        .map((byte) => `\\${byte.toString(16).padStart(2, '0')}`)
        .join('');
    }
    if (
      character === LDAP_DN_BACKSLASH ||
      '\",+;<>='.includes(character) ||
      (index === 0 && (character === ' ' || character === '#')) ||
      (index === characters.length - 1 && character === ' ')
    ) {
      return `\\${character}`;
    }
    return character;
  }).join('');
}

const SIMPLE_USER_DN_TEMPLATE = /^\(([A-Za-z][A-Za-z0-9-]*|[0-9]+(?:\.[0-9]+)+)=\{\{username\}\}\)$/;

/**
 * Resolve the only user lookup form supported by the dependency-free client.
 * The configured equality filter is treated as an RDN template, not executed
 * as an LDAP search.
 */
export function resolveLdapUserDn(config: LdapConfig, username: string): string {
  const match = SIMPLE_USER_DN_TEMPLATE.exec(config.searchFilter);
  if (!match?.[1]) {
    throw new Error(
      'LDAP preview client requires a simple user-DN template such as "(uid={{username}})"; directory search filters are not supported',
    );
  }

  const searchBase = config.searchBase.trim();
  if (!searchBase || /[\0\r\n]/.test(searchBase)) {
    throw new Error('LDAP searchBase must be a non-empty distinguished name');
  }

  return `${match[1]}=${escapeLdapDnValue(username)},${searchBase}`;
}

export function resolveLdapTransport(
  url: URL,
  tlsEnabled: boolean,
): { tls: boolean; port: number } {
  // The secure URL scheme is authoritative. A stale/omitted tlsEnabled flag
  // must never downgrade an ldaps:// connection to plaintext LDAP.
  const useTls = url.protocol === 'ldaps:' || tlsEnabled;
  return {
    tls: useTls,
    port: Number(url.port || (useTls ? '636' : '389')),
  };
}

/**
 * Authenticate a user via LDAP and return the identity known from the bind.
 *
 * Flow:
 *   1. Connect to LDAP server (optionally with TLS)
 *   2. Bind with the configured service account
 *   3. Construct a user DN from the supported simple DN template
 *   4. Re-bind as the user to verify the password
 *
 * The default client cannot discover email, display name, or groups, so those
 * values are not fabricated in the returned LdapUserInfo.
 */
export async function authenticateLdap(
  config: LdapConfig,
  username: string,
  password: string,
): Promise<LdapUserInfo> {
  if (!username || !password) {
    throw new Error('Username and password are required');
  }
  if (username.length > 256) {
    throw new Error('Username too long');
  }

  // Use the injected LDAP client (allows mocking in tests, real impl in prod)
  const client = getLdapClient();
  return client.authenticate(config, username, password);
}

/**
 * Test LDAP connectivity by performing a service-account bind.
 */
export async function testLdapConnection(config: LdapConfig): Promise<{ success: boolean; error?: string }> {
  const client = getLdapClient();
  return client.testConnection(config);
}

// ── Pluggable LDAP client (allows DI for testing) ─────────────────────────

export interface LdapClient {
  authenticate(config: LdapConfig, username: string, password: string): Promise<LdapUserInfo>;
  testConnection(config: LdapConfig): Promise<{ success: boolean; error?: string }>;
}

let _ldapClient: LdapClient | null = null;

export function setLdapClient(client: LdapClient): void {
  _ldapClient = client;
}

export function getLdapClient(): LdapClient {
  if (!_ldapClient) {
    _ldapClient = createDefaultLdapClient();
  }
  return _ldapClient;
}

/**
 * Default LDAP client using Node.js net/tls sockets with the LDAP wire
 * protocol. It intentionally implements bind operations only.
 */
export function createDefaultLdapClient(
  connectSocket: typeof safeConnect = safeConnect,
): LdapClient {
  const createConnector = (config: LdapConfig, timeoutMs: number): (() => Promise<Socket>) => {
    if (!config.bindDn.trim() || !config.bindPassword) {
      throw new Error('LDAP bindDn and bindPassword are required');
    }

    const url = validateOutboundUrl(config.ldapUrl, {
      allowedProtocols: ['ldap:', 'ldaps:'],
      allowPrivateHosts: appConfig.allowPrivateSsoHosts,
      allowInsecureHttp: true,
    });
    if (url.protocol === 'ldap:' && !config.tlsEnabled && !appConfig.allowInsecureSsoUrls) {
      throw new Error('Insecure LDAP URLs are disabled; use LDAPS or enable SSO_ALLOW_INSECURE_URLS');
    }
    const transport = resolveLdapTransport(url, config.tlsEnabled);

    return () => connectSocket(config.ldapUrl, {
      port: transport.port,
      tls: transport.tls,
      rejectUnauthorized: appConfig.ldapTlsRejectUnauthorized,
      timeoutMs,
      policy: {
        allowedProtocols: ['ldap:', 'ldaps:'],
        allowPrivateHosts: appConfig.allowPrivateSsoHosts,
        allowInsecureHttp: true,
      },
    });
  };

  return {
    async authenticate(config, username, password): Promise<LdapUserInfo> {
      const connect = createConnector(config, 10_000);
      const userDn = resolveLdapUserDn(config, username);

      let socket: Socket | null = null;

      try {
        socket = await connect();

        // Step 1: Service-account bind
        const svcBound = await ldapBind(socket, config.bindDn, config.bindPassword);
        if (!svcBound) throw new Error('LDAP service-account bind failed');

        // Step 2: User bind (verify password)
        socket.destroy();
        socket = await connect();
        const userBound = await ldapBind(socket, userDn, password);
        if (!userBound) throw new Error('Invalid LDAP credentials');

        return {
          dn: userDn,
          uid: username,
          groups: [],
        };
      } finally {
        socket?.destroy();
      }
    },

    async testConnection(config): Promise<{ success: boolean; error?: string }> {
      let socket: Socket | null = null;
      try {
        // Validate the default client's restricted DN-template contract as
        // part of testing whether this configuration is usable.
        resolveLdapUserDn(config, 'connection-test');
        const connect = createConnector(config, 5_000);
        socket = await connect();
        const svcBound = await ldapBind(socket, config.bindDn, config.bindPassword);
        if (!svcBound) throw new Error('LDAP service-account bind failed');

        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Connection failed' };
      } finally {
        socket?.destroy();
      }
    },
  };
}

function encodeBerLength(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('Invalid LDAP BER length');
  }
  if (length < 0x80) return Buffer.from([length]);

  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 0x100);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeBerElement(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeBerLength(content.length), content]);
}

function encodeLdapBindRequest(dn: string, password: string): Buffer {
  const bindBody = Buffer.concat([
    encodeBerElement(0x02, Buffer.from([0x03])),
    encodeBerElement(0x04, Buffer.from(dn, 'utf8')),
    encodeBerElement(0x80, Buffer.from(password, 'utf8')),
  ]);
  const message = Buffer.concat([
    encodeBerElement(0x02, Buffer.from([0x01])),
    encodeBerElement(0x60, bindBody),
  ]);
  return encodeBerElement(0x30, message);
}

const MAX_LDAP_BIND_RESPONSE_BYTES = 1024 * 1024;

function completeBerFrameLength(data: Buffer): number | null {
  if (data.length < 2) return null;

  const firstLengthByte = data[1]!;
  let contentLength: number;
  let headerLength = 2;
  if ((firstLengthByte & 0x80) === 0) {
    contentLength = firstLengthByte;
  } else {
    const lengthBytes = firstLengthByte & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4) {
      throw new Error('Invalid LDAP BER response length');
    }
    if (data.length < 2 + lengthBytes) return null;

    contentLength = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      contentLength = (contentLength * 256) + data[2 + index]!;
    }
    headerLength += lengthBytes;
  }

  const frameLength = headerLength + contentLength;
  if (frameLength > MAX_LDAP_BIND_RESPONSE_BYTES) {
    throw new Error('LDAP bind response exceeds size limit');
  }
  return data.length >= frameLength ? frameLength : null;
}

function ldapBind(socket: Socket, dn: string, password: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('LDAP bind response timed out'));
    }, 5_000);

    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (data: Buffer): void => {
      response = Buffer.concat([response, data]);
      if (response.length > MAX_LDAP_BIND_RESPONSE_BYTES) {
        cleanup();
        reject(new Error('LDAP bind response exceeds size limit'));
        return;
      }

      let frameLength: number | null;
      try {
        frameLength = completeBerFrameLength(response);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (frameLength === null) return;

      const frame = response.subarray(0, frameLength);
      // A BindResponse begins with APPLICATION[1] and its first field is the
      // ENUMERATED resultCode. Parse only after the complete BER frame arrives.
      const bindResponseIndex = frame.indexOf(0x61);
      const resultIndex = bindResponseIndex >= 0
        ? frame.indexOf(Buffer.from([0x0a, 0x01]), bindResponseIndex)
        : -1;
      cleanup();
      resolve(resultIndex >= 0 && frame[resultIndex + 2] === 0);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('LDAP connection closed before bind response'));
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write(encodeLdapBindRequest(dn, password));
  });
}
