import { randomInt } from 'node:crypto';
import type { HttpResponse, SuiteContext, SuiteDefinition, TestResult } from '../types.js';
import { AssertionError, expectEqual, expectStatus, expectString, skip, test } from '../helpers.js';

/**
 * OACP artifact lifecycle (profile `oacp-artifact-jws-v1`): issue → persist
 * (read back and replay) → Token Status List → relying-party verification
 * with the SDK verifier → revoke → status flips → protocol adapter artifact.
 *
 * Issuance and the artifact routes take the internal service token
 * (`--internal-token`, or GRANTEX_CONFORMANCE_INTERNAL_TOKEN) and fall back
 * to the operator API key. Every run issues artifacts for a merchant and
 * seller id of its own, and revokes only the artifact it issued.
 */

const SPEC = 'OACP';
const AUTHORITY_PATH = '/v1/commerce/oacp/c6z/authority-requests';
const ARTIFACTS_PATH = '/v1/commerce/oacp/artifacts';
const STATUS_PATH_RE = /^\/status\/oacp\/[A-Za-z0-9_-]+$/;
const DETACHED_JWS_RE = /^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/;
const STATUS_LIST_MEDIA_TYPE = 'application/statuslist+jwt';

type Json = Record<string, unknown>;

export interface OacpVerificationLike {
  valid: boolean;
  refusalCode?: string;
  status?: string;
}

/** The part of `@grantex/sdk` the suite uses. */
export interface OacpVerifierModule {
  verifyOacpArtifact(
    envelope: unknown,
    payload: unknown,
    options: {
      issuer: string;
      jwks: { keys: Array<Record<string, unknown>> };
      now?: Date;
      expectedScope?: Record<string, string>;
      statusListFetcher?: (uri: string) => Promise<string>;
      allowLoopbackHttp?: boolean;
    },
  ): Promise<OacpVerificationLike>;
  readOacpStatus(options: {
    token: string;
    uri: string;
    idx: number;
    jwks: unknown;
    issuer: string;
    now: Date;
  }): { status: number };
}

/** Loads the SDK verifier. Kept dynamic so the core suites run without it installed. */
export async function loadOacpVerifier(): Promise<OacpVerifierModule> {
  const specifier = '@grantex/sdk';
  let mod: Partial<OacpVerifierModule>;
  try {
    mod = (await import(specifier)) as Partial<OacpVerifierModule>;
  } catch {
    throw new Error('the oacp suite needs @grantex/sdk with verifyOacpArtifact installed beside @grantex/conformance');
  }
  if (typeof mod.verifyOacpArtifact !== 'function' || typeof mod.readOacpStatus !== 'function') {
    throw new Error('the installed @grantex/sdk has no verifyOacpArtifact; install a release that ships the OACP verifier');
  }
  return mod as OacpVerifierModule;
}

interface IssuedArtifact {
  artifact_family?: string;
  artifact_type?: string;
  envelope: Json;
  payload: Json;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

function statusReference(envelope: Json): { uri: string; idx: number } {
  const status = isObject(envelope['status']) ? envelope['status']['status_list'] : undefined;
  if (!isObject(status) || typeof status['uri'] !== 'string' || !Number.isSafeInteger(status['idx'])) {
    throw new AssertionError(`artifact ${String(envelope['artifact_id'])} has no status.status_list { idx, uri }`);
  }
  return { uri: status['uri'], idx: status['idx'] as number };
}

function protectedHeader(signature: string): Json | null {
  try {
    const header: unknown = JSON.parse(Buffer.from(signature.split('.')[0] ?? '', 'base64url').toString('utf8'));
    return isObject(header) ? header : null;
  } catch {
    return null;
  }
}

function suffix(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 12; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export interface OacpSuiteOptions {
  /** Supplies the SDK verifier. Default: `@grantex/sdk`. */
  loadVerifier?: () => Promise<OacpVerifierModule>;
  /** The clock (tests). */
  now?: () => Date;
}

export function createOacpSuite(options: OacpSuiteOptions = {}): SuiteDefinition {
  const loadVerifier = options.loadVerifier ?? loadOacpVerifier;
  const clock = options.now ?? (() => new Date());

  return {
    name: 'oacp',
    description: 'OACP artifacts: issue, persist, status list, SDK verification, revoke',
    optional: true,
    run: async (ctx: SuiteContext): Promise<TestResult[]> => {
      const results: TestResult[] = [];
      const token = ctx.internalToken ?? ctx.apiKey;
      const issuer = ctx.oacpIssuer ?? ctx.baseUrl;
      const tenantId = ctx.oacpTenantId ?? 'cten_CONFORMANCE';
      const runId = suffix();
      const merchantId = `mch_CONF${runId}`;
      const sellerAgentId = `seller_CONF${runId}`;
      const allowLoopbackHttp = isLoopback(ctx.baseUrl) || isLoopback(issuer);
      const scope = { tenant_id: tenantId, merchant_id: merchantId, seller_agent_id: sellerAgentId };

      const internal = <T>(method: string, path: string, body?: unknown): Promise<HttpResponse<T>> =>
        ctx.http.doRequestWithToken<T>(method, path, token, body);
      const readStatusList = async (uri: string): Promise<string> => {
        const path = new URL(uri).pathname;
        if (!STATUS_PATH_RE.test(path)) throw new AssertionError(`status list URI path ${path} is not /status/oacp/<list>`);
        const res = await ctx.http.requestPublic<string>('GET', path);
        expectStatus(res, 200);
        const type = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        expectEqual(type, STATUS_LIST_MEDIA_TYPE, 'status list content-type');
        return res.rawText.trim();
      };

      let verifier: OacpVerifierModule | null = null;
      let verifierError = '';
      try {
        verifier = await loadVerifier();
      } catch (err) {
        verifierError = err instanceof Error ? err.message : String(err);
      }

      let jwks: { keys: Array<Record<string, unknown>> } | null = null;
      // Written by the steps below; read after each one.
      const state: { artifacts: IssuedArtifact[]; target: IssuedArtifact | null; revoked: boolean } = {
        artifacts: [],
        target: null,
        revoked: false,
      };

      // 1. Issue
      results.push(await test('issue: an authority request issues signed OACP artifacts', SPEC, async () => {
        const now = clock();
        const observed = new Date(now.getTime() - 60_000).toISOString();
        const evidenceRef = `conformance:shopify:evidence:${runId}:redacted`;
        const res = await internal<{ artifacts?: IssuedArtifact[]; status?: string }>('POST', AUTHORITY_PATH, {
          request: {
            request_id: `conformance_${runId}`,
            ...scope,
            merchant_display_name: 'Conformance Store',
            commerce_categories: ['home_goods'],
            connector_choice: 'shopify',
            connector_mode: 'read_only',
            requested_authority_scope: ['merchant_profile', 'catalog_snapshot', 'price_snapshot', 'inventory_snapshot'],
            artifact_cache_scope: scope,
            source_freshness_policy: { max_age_seconds: 600 },
            source_evidence_ref: evidenceRef,
            source_observed_at: observed,
            no_payment_execution: true,
            no_public_discovery_enablement: true,
          },
          connector_evidence: {
            evidence_id: `conformance_evidence_${runId}`,
            ...scope,
            source_system: 'shopify',
            source_evidence_ref: evidenceRef,
            source_observed_at: observed,
            product_count: 2,
            variant_count: 3,
            currency: 'INR',
            catalog_sample_refs: [`conformance:catalog:item:${runId}:redacted`],
            price_snapshot_refs: [`conformance:price:item:${runId}:redacted`],
            inventory_snapshot_refs: [`conformance:inventory:item:${runId}:redacted`],
            no_payment_execution: true,
            no_public_discovery_enablement: true,
          },
        });
        expectStatus(res, 201);
        const issued = Array.isArray(res.body.artifacts) ? res.body.artifacts : [];
        if (issued.length === 0) throw new AssertionError('the issuance returned no artifacts');
        for (const artifact of issued) {
          if (!isObject(artifact.envelope) || !isObject(artifact.payload)) throw new AssertionError('an artifact has no envelope or payload');
          const signature = artifact.envelope['signature'];
          if (typeof signature !== 'string' || !DETACHED_JWS_RE.test(signature)) {
            throw new AssertionError(`artifact ${String(artifact.envelope['artifact_id'])} has no detached JWS`);
          }
          const header = protectedHeader(signature);
          if (
            header === null || Object.keys(header).sort().join(',') !== 'alg,kid,typ'
            || header['alg'] !== 'ES256' || header['typ'] !== 'oacp-artifact+jws' || header['kid'] !== artifact.envelope['issuer_key_id']
          ) {
            throw new AssertionError(`artifact ${String(artifact.envelope['artifact_id'])} has no detached JWS with the OACP header`);
          }
          expectEqual(artifact.envelope['signature_alg'], 'ES256', 'signature_alg');
          expectEqual(artifact.envelope['issuer'], issuer, 'envelope.issuer (pin it with --oacp-issuer)');
          const { uri } = statusReference(artifact.envelope);
          expectEqual(artifact.envelope['revocation_status_url'], uri, 'revocation_status_url');
        }
        state.artifacts = issued;
        state.target = issued.find((a) => a.artifact_type === 'catalog_snapshot') ?? issued[0]!;
      }));

      const blocked = (name: string): TestResult => skip(name, SPEC, 'the issue step did not produce artifacts');
      if (state.target === null) {
        for (const name of ['persist: read back', 'persist: replay', 'status list: VALID', 'verify: SDK verifier', 'verify: tampering refused', 'revoke', 'status flips', 'adapter render']) {
          results.push(blocked(name));
        }
        return results;
      }
      const chosen: IssuedArtifact = state.target;
      const artifacts = state.artifacts;
      const artifactId = String(chosen.envelope['artifact_id']);

      // 2. Persist: read back and replay
      results.push(await test('persist: the issued artifact reads back unchanged', SPEC, async () => {
        const res = await internal<{ envelope?: Json; payload?: Json; status?: string }>('GET', `${ARTIFACTS_PATH}/${encodeURIComponent(artifactId)}`);
        expectStatus(res, 200);
        if (!isObject(res.body.envelope) || !isObject(res.body.payload)) throw new AssertionError('the response has no envelope or payload');
        expectEqual(res.body.envelope['signature'], chosen.envelope['signature'], 'envelope.signature');
        expectEqual(res.body.envelope['payload_hash'], chosen.envelope['payload_hash'], 'envelope.payload_hash');
        expectEqual(res.body.status, 'issued', 'status');
      }));

      results.push(await test('persist: replay lists the issued artifacts for the scope', SPEC, async () => {
        const query = new URLSearchParams({ ...scope, limit: '100' });
        const res = await internal<{ items?: unknown[]; artifacts?: unknown[] }>('GET', `${ARTIFACTS_PATH}?${query.toString()}`);
        expectStatus(res, 200);
        const rows = Array.isArray(res.body.items) ? res.body.items : Array.isArray(res.body.artifacts) ? res.body.artifacts : null;
        if (rows === null) throw new AssertionError('the replay response has no items array');
        const ids = new Set(rows.map((row) => {
          if (!isObject(row)) return undefined;
          if (typeof row['artifact_id'] === 'string') return row['artifact_id'];
          return isObject(row['envelope']) ? row['envelope']['artifact_id'] : undefined;
        }));
        const missing = artifacts.map((a) => String(a.envelope['artifact_id'])).filter((id) => !ids.has(id));
        if (missing.length > 0) throw new AssertionError(`replay is missing ${missing.join(', ')}`);
        for (const row of rows) {
          if (isObject(row) && isObject(row['envelope']) && row['envelope']['merchant_id'] !== merchantId) {
            throw new AssertionError('replay returned an artifact outside the requested scope');
          }
        }
      }));

      // 3. Status list
      const reference = statusReference(chosen.envelope);
      const loadJwks = async () => {
        const res = await ctx.http.requestPublic<{ keys?: Array<Record<string, unknown>> }>('GET', '/.well-known/jwks.json');
        expectStatus(res, 200);
        if (!Array.isArray(res.body.keys)) throw new AssertionError('the JWKS has no keys');
        const kid = chosen.envelope['issuer_key_id'];
        expectString(kid, 'issuer_key_id');
        if (!(kid as string).startsWith('oacp-')) throw new AssertionError(`issuer_key_id ${String(kid)} does not start with oacp-`);
        if (!res.body.keys.some((k) => k['kid'] === kid && k['kty'] === 'EC' && k['crv'] === 'P-256')) {
          throw new AssertionError(`the JWKS does not publish the P-256 key ${String(kid)}`);
        }
        return { keys: res.body.keys };
      };

      const statusAt = async (): Promise<number> => {
        if (!verifier) throw new AssertionError(verifierError);
        jwks ??= await loadJwks();
        const listToken = await readStatusList(reference.uri);
        return verifier.readOacpStatus({ token: listToken, uri: reference.uri, idx: reference.idx, jwks, issuer, now: clock() }).status;
      };

      results.push(await test('status list: served as application/statuslist+jwt with the entry VALID', SPEC, async () => {
        expectEqual(await statusAt(), 0, `status at ${reference.idx}`);
      }));

      // 4. Relying-party verification with the SDK verifier
      const verify = async (artifact: IssuedArtifact, payload: unknown = artifact.payload, envelope: unknown = artifact.envelope) => {
        if (!verifier) throw new AssertionError(verifierError);
        jwks ??= await loadJwks();
        return verifier.verifyOacpArtifact(envelope, payload, {
          issuer,
          jwks,
          now: clock(),
          expectedScope: scope,
          statusListFetcher: readStatusList,
          allowLoopbackHttp,
        });
      };

      results.push(await test('verify: the SDK verifier accepts every issued artifact', SPEC, async () => {
        for (const artifact of artifacts) {
          const result = await verify(artifact);
          if (!result.valid) {
            throw new AssertionError(`artifact ${String(artifact.envelope['artifact_id'])} refused: ${result.refusalCode ?? 'unknown'}`);
          }
          expectEqual(result.status, 'valid', 'verification status');
        }
      }));

      results.push(await test('verify: a tampered payload or envelope is refused', SPEC, async () => {
        const payload = await verify(chosen, { ...chosen.payload, conformance_tamper: true });
        expectEqual(payload.refusalCode, 'payload_hash_mismatch', 'refusal for a tampered payload');
        const envelope = await verify(chosen, chosen.payload, { ...chosen.envelope, merchant_id: `${merchantId}_OTHER` });
        expectEqual(envelope.refusalCode, 'detached_jws_verification_failed', 'refusal for a tampered envelope');
      }));

      // 5. Revoke
      results.push(await test('revoke: the artifact is revoked and reads back revoked', SPEC, async () => {
        const res = await internal<Json>('POST', `${ARTIFACTS_PATH}/${encodeURIComponent(artifactId)}/revoke`, { reason: 'conformance' });
        if (res.status !== 200 && res.status !== 201) expectStatus(res, 200);
        state.revoked = true;
        const after = await internal<{ status?: string; revoked_at?: unknown }>('GET', `${ARTIFACTS_PATH}/${encodeURIComponent(artifactId)}`);
        expectStatus(after, 200);
        expectEqual(after.body.status, 'revoked', 'status after revoke');
        expectString(after.body.revoked_at, 'revoked_at');
        const revocation = isObject(res.body['revocation_artifact']) ? res.body['revocation_artifact'] : null;
        if (revocation && isObject(revocation['envelope']) && isObject(revocation['payload'])) {
          expectEqual(revocation['envelope']['artifact_type'], 'revocation', 'revocation artifact type');
          const named = JSON.stringify(revocation['payload']).includes(artifactId);
          if (!named) throw new AssertionError('the revocation artifact payload does not name the revoked artifact');
        }
      }));

      // 6. Status flips
      if (!state.revoked) {
        results.push(skip('status flips: the entry reads INVALID and the verifier refuses', SPEC, 'the revoke step failed'));
      } else {
        results.push(await test('status flips: the entry reads INVALID and the verifier refuses', SPEC, async () => {
          expectEqual(await statusAt(), 1, `status at ${reference.idx}`);
          const result = await verify(chosen);
          expectEqual(result.refusalCode, 'artifact_revoked', 'refusal after revoke');
        }));
      }

      // 7. Protocol adapter artifact
      const adapters = artifacts.filter((a) => a.artifact_family === 'protocol_adapter' && a !== chosen);
      if (adapters.length === 0) {
        results.push(skip('adapter render: protocol adapter artifact', SPEC, 'the issuance returned no protocol_adapter artifact'));
      } else {
        results.push(await test('adapter render: the protocol adapter artifact verifies and stays non-binding', SPEC, async () => {
          for (const adapter of adapters) {
            const result = await verify(adapter);
            if (!result.valid) throw new AssertionError(`the adapter artifact was refused: ${result.refusalCode ?? 'unknown'}`);
            const surfaces = adapter.payload['adapter_surfaces'];
            if (!Array.isArray(surfaces) || surfaces.length === 0) throw new AssertionError('the adapter artifact lists no adapter_surfaces');
            if (adapter.payload['allowed_to_execute'] === true) throw new AssertionError('the adapter artifact allows execution');
          }
        }));
      }

      return results;
    },
  };
}

export const oacpSuite: SuiteDefinition = createOacpSuite();
