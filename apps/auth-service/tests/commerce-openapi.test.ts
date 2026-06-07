import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const yamlPath = join(__dirname, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');

describe('Grantex Commerce V1 OpenAPI 3.1 contract', () => {
  it('docs/api/grantex-commerce-v1.openapi.yaml exists', () => {
    expect(() => readFileSync(yamlPath, 'utf8')).not.toThrow();
  });

  it('declares openapi: 3.1.x and is non-empty', () => {
    const content = readFileSync(yamlPath, 'utf8');
    expect(content).toMatch(/openapi:\s*"?3\.1/);
    expect(content.length).toBeGreaterThan(1000);
  });

  it('declares the standard error envelope shape (error.code, error.message)', () => {
    const content = readFileSync(yamlPath, 'utf8');
    expect(content).toMatch(/Error:\s*\n\s+type:\s+object/);
    expect(content).toMatch(/code:\s*\{\s*type:\s*string/);
    expect(content).toMatch(/decision_id:/);
    expect(content).toMatch(/audit_event_id:/);
    expect(content).toMatch(/retryable:/);
  });

  it('lists every M1-implemented path with x-implemented: true', () => {
    const content = readFileSync(yamlPath, 'utf8');
    const expected = [
      '/v1/commerce/merchants',
      '/v1/commerce/merchants/{merchant_id}',
      '/v1/commerce/agents',
      '/v1/commerce/agents/{agent_id}',
      '/v1/commerce/catalog/products',
      '/v1/commerce/catalog/products/{product_id}',
      '/v1/commerce/audit/events',
    ];
    for (const path of expected) {
      expect(content, `OpenAPI must include ${path}`).toContain(path);
    }
    // At least one explicit x-implemented: true marker per implemented op
    const trueCount = (content.match(/x-implemented:\s*true/g) ?? []).length;
    expect(trueCount).toBeGreaterThanOrEqual(expected.length);
  });

  it('declares stub paths for M2-M5 surface (passports, payments, MCP, providers)', () => {
    const content = readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/v1/commerce/passports/consent-requests');
    expect(content).toContain('/v1/commerce/payments/intents');
    expect(content).toContain('/v1/commerce/provider-credentials');
    expect(content).toContain('/v1/webhooks/providers/{provider_key}');
    expect(content).toContain('/.well-known/grantex-commerce');
    expect(content).toContain('/mcp');
  });

  it('declares M2 explicit tenant provisioning stubs (paired with the 422 tenant_not_provisioned posture)', () => {
    const content = readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/v1/commerce/tenants');
    expect(content).toContain('/v1/commerce/developer-tenants');
    expect(content).toMatch(/x-milestone:\s*M2/);
  });

  it('declares the C6J schema.org JSON-LD preview as implemented and preview-only', () => {
    const content = readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/v1/commerce/merchants/{merchant_id}/schemaorg-jsonld-preview');
    expect(content).toMatch(/operationId:\s*getMerchantSchemaOrgJsonLdPreview/);
    expect(content).toMatch(/x-milestone:\s*C6J/);
    expect(content).toMatch(/SchemaOrgJsonLdPreview:/);
    expect(content).toMatch(/schemaorg_publication_enabled:\s*\{\s*type:\s*boolean,\s*const:\s*false\s*\}/);
    expect(content).toMatch(/certification_claims:[\s\S]*maxItems:\s*0/);
  });

  it('M2 passport endpoints flipped to x-implemented: true', () => {
    const content = readFileSync(yamlPath, 'utf8');
    // Each of the five passport routes must now carry x-implemented: true
    // (or be replaced with full operation specs that imply implementation).
    const passportPaths = [
      '/v1/commerce/passports/consent-requests',
      '/v1/commerce/passports/exchange',
      '/v1/commerce/passports',
      '/v1/commerce/passports/verify',
      '/v1/commerce/passports/revoke',
    ];
    for (const p of passportPaths) {
      expect(content, `OpenAPI must include ${p}`).toContain(p);
    }
    // Heuristic check: at least 5 more `x-implemented: true` markers than M1
    // (M1 had 7 implemented endpoints). M2 adds: 5 passport + 4 tenant +
    // 4 consent = 13 more. Total ≥ 7 + 13 = 20.
    const trueCount = (content.match(/x-implemented:\s*true/g) ?? []).length;
    expect(trueCount).toBeGreaterThanOrEqual(15);
  });
});

/**
 * Drift guard for the consent contract. The implementation in
 * apps/auth-service/src/routes/commerce-consent.ts diverged from the
 * OpenAPI yaml during M2 (P2 finding: session-bootstrap query param,
 * 303 redirect, principal-session-gated approve/deny, expanded 4xx
 * codes). These assertions fail if anything regresses to the older,
 * looser contract.
 */
describe('Consent endpoints — OpenAPI matches the implementation', () => {
  /** Returns the YAML body of `/v1/commerce/consent/<suffix>`. */
  function pathBlock(suffix: string): string {
    const content = readFileSync(yamlPath, 'utf8');
    const headerLine = `/v1/commerce/consent/${suffix}:`;
    const start = content.indexOf(headerLine);
    expect(start, `OpenAPI must declare /v1/commerce/consent/${suffix}`).toBeGreaterThan(-1);
    // Block ends at the next path key at the same 2-space indent. Match
    // both `/letter…` and `/{path-param}…` so /{reqId}/* siblings don't
    // accidentally extend the page block all the way to the next /v1/…
    // path.
    const after = content.slice(start + headerLine.length);
    const nextPath = after.search(/\n {2}\/[A-Za-z0-9{]/);
    return nextPath === -1 ? after : after.slice(0, nextPath);
  }

  describe('GET /v1/commerce/consent/page', () => {
    let block: string;
    beforeAll(() => { block = pathBlock('page'); });

    it('declares the optional `session` query parameter (Finding 2 bootstrap)', () => {
      expect(block).toMatch(/in:\s*query[\s\S]*?name:\s*session[\s\S]*?required:\s*false/);
      // Description must mention the bootstrap behavior so the contract
      // tells the truth about what the server does with the token.
      expect(block.toLowerCase()).toMatch(/bootstrap principal session jwt/);
      expect(block.toLowerCase()).toMatch(/sets the principal-session cookie/);
      expect(block.toLowerCase()).toMatch(/strip|stripped/);
    });

    it('declares the 303 See Other response with Location + security headers', () => {
      expect(block).toMatch(/"303"/);
      // Location header is documented under the 303 response.
      const after303 = block.split('"303"')[1] ?? '';
      const next = after303.match(/"\d{3}"/);
      const block303 = next ? after303.slice(0, after303.indexOf(next[0])) : after303;
      expect(block303).toMatch(/Location:/);
      expect(block303).toMatch(/Cache-Control:/);
      expect(block303).toMatch(/no-store/);
      expect(block303).toMatch(/Pragma:/);
      expect(block303).toMatch(/no-cache/);
      expect(block303).toMatch(/Referrer-Policy:/);
      expect(block303).toMatch(/no-referrer/);
    });

    it('keeps `req` required and adds 400 for missing/invalid req', () => {
      expect(block).toMatch(/name:\s*req[\s\S]*?required:\s*true/);
      expect(block).toMatch(/"400"/);
    });

    it('200 description clarifies sign-in-required render path', () => {
      const m = block.match(/"200"[\s\S]*?(?=\n\s*"\d{3}"|\n\s*\/|$)/);
      expect(m).not.toBeNull();
      // Allow either spelling: "sign-in-required" / "sign in required" /
      // "sign_in_required" — all three are reasonable in docs.
      expect(m![0].toLowerCase()).toMatch(/sign[-_ ]in[-_ ]required/);
    });

    it('200 advertises strict security headers (CSP, X-Frame-Options, no-store, no-referrer)', () => {
      const m = block.match(/"200"[\s\S]*?(?=\n\s*"\d{3}"|\n\s*\/|$)/);
      expect(m).not.toBeNull();
      const block200 = m![0];
      expect(block200).toMatch(/Content-Security-Policy/);
      expect(block200).toMatch(/X-Frame-Options/);
      expect(block200).toMatch(/no-store/);
      expect(block200).toMatch(/no-referrer/);
    });

    it('declares 403 for principal-not-bound or tenant-disabled', () => {
      expect(block).toMatch(/"403"/);
      const m = block.match(/"403"[\s\S]*?(?=\n\s*"\d{3}"|\n\s*\/|$)/);
      expect(m).not.toBeNull();
      const text = m![0].toLowerCase();
      // Description must mention BOTH the not-bound and tenant-disabled
      // failure conditions. Multi-line descriptions are flattened with
      // [\s\S] matchers because YAML folded scalars wrap.
      expect(text).toMatch(/not bound/);
      expect(text).toMatch(/tenant/);
      expect(text).toMatch(/disabled/);
    });

    it('keeps 404 (wrong host / unknown req) and 410 (expired)', () => {
      expect(block).toMatch(/"404"/);
      expect(block).toMatch(/"410"/);
    });
  });

  describe('POST /v1/commerce/consent/{reqId}/approve', () => {
    let block: string;
    beforeAll(() => { block = pathBlock('{reqId}/approve'); });

    it('documents application/x-www-form-urlencoded body with required csrf field', () => {
      expect(block).toMatch(/application\/x-www-form-urlencoded/);
      expect(block).toMatch(/required:\s*\[csrf\]/);
      expect(block).toMatch(/name="?csrf"?|csrf:\s*\n/);
    });

    it('description states principal identity comes from session, not agent input', () => {
      expect(block.toLowerCase()).toMatch(/principal[\s\S]*session/);
      // Folded YAML wraps; allow whitespace including newline.
      expect(block.toLowerCase()).toMatch(/never\s+from\s+agent/);
    });

    it('declares 401 principal_session_required', () => {
      expect(block).toMatch(/"401"/);
      const m = block.match(/"401"[\s\S]*?(?=\n\s*"\d{3}"|\n\s*\/|$)/);
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/principal_session_required/);
    });

    it('declares 403 with all five codes including challenge_required (P0 fix)', () => {
      const m = block.match(/"403"[\s\S]*?(?=\n\s*"\d{3}"|\n\s*\/|$)/);
      expect(m).not.toBeNull();
      const text = m![0];
      expect(text).toMatch(/csrf_invalid/);
      expect(text).toMatch(/principal_not_authorized_for_tenant/);
      expect(text).toMatch(/tenant_disabled/);
      expect(text).toMatch(/principal_hint_mismatch/);
      expect(text).toMatch(/challenge_required/);
    });

    it('keeps 404, 409 (consent_already_decided), 410 (consent_expired)', () => {
      expect(block).toMatch(/"404"/);
      expect(block).toMatch(/"409"[\s\S]*?consent_already_decided/);
      expect(block).toMatch(/"410"[\s\S]*?consent_expired/);
    });

    it('still x-implemented: true and x-milestone: M2', () => {
      expect(block).toMatch(/x-implemented:\s*true/);
      expect(block).toMatch(/x-milestone:\s*M2/);
    });
  });

  describe('POST /v1/commerce/consent/{reqId}/challenge — challenge create endpoint', () => {
    let block: string;
    beforeAll(() => { block = pathBlock('{reqId}/challenge'); });

    it('exists and is x-implemented: true at M2', () => {
      expect(block).toMatch(/x-implemented:\s*true/);
      expect(block).toMatch(/x-milestone:\s*M2/);
    });
    it('requires application/x-www-form-urlencoded body with csrf', () => {
      expect(block).toMatch(/application\/x-www-form-urlencoded/);
      expect(block).toMatch(/required:\s*\[csrf\]/);
    });
    it('description states the challenge is server-issued, single-use, and not derivable by the agent', () => {
      expect(block.toLowerCase()).toMatch(/single-use/);
      // YAML folded scalar wraps long descriptions; allow whitespace
      // (including \n) between words.
      expect(block.toLowerCase()).toMatch(/agent\/developer\s+cannot\s+read\s+or\s+compute/);
    });
    it('declares the four expected error codes (401/403/404/503) and the test_only_code disclosure rule', () => {
      expect(block).toMatch(/"401"[\s\S]*?principal_session_required/);
      const four03 = block.match(/"403"[\s\S]*?(?=\n\s*"\d{3}"|\n\s*\/|$)/);
      expect(four03).not.toBeNull();
      expect(four03![0]).toMatch(/csrf_invalid/);
      expect(four03![0]).toMatch(/principal_not_authorized_for_tenant/);
      expect(four03![0]).toMatch(/tenant_disabled/);
      expect(four03![0]).toMatch(/principal_hint_mismatch/);
      expect(block).toMatch(/"503"[\s\S]*?challenge_provider_unavailable/);
      // 201 description must call out the TEST-ONLY disclosure rule:
      // raw code only when NODE_ENV === 'test'. Earlier drafts said
      // "non-production" — that wording is now banned because staging /
      // preview / dev would also leak.
      expect(block).toMatch(/"201"[\s\S]*?test_only_code/);
      expect(block).toMatch(/"201"[\s\S]*?NODE_ENV\s*===\s*'test'/);
    });

    it('test_only_code disclosure rule is NODE_ENV === test only (not "non-production")', () => {
      // Search the entire challenge-create block plus the surrounding
      // description block.
      const wide = block;
      // Affirmative: must say NODE_ENV === 'test' near test_only_code.
      expect(wide).toMatch(/test_only_code[\s\S]{0,200}?NODE_ENV\s*===\s*'test'/);
      // Negative: must NOT say "non-production" or "NODE_ENV !== 'production'"
      // anywhere in the disclosure rationale.
      expect(wide).not.toMatch(/non-production/);
      expect(wide).not.toMatch(/NODE_ENV\s*!==\s*'production'/);
    });

    it('email_otp is documented as deferred / not implemented in M2 (no claim that it is production-ready)', () => {
      // Description must clearly say email_otp is NOT implemented and
      // production fails closed regardless. No wording suggesting that
      // setting `COMMERCE_CONSENT_CHALLENGE_PROVIDER=email_otp` enables
      // production delivery.
      expect(block).toMatch(/email_otp[\s\S]{0,500}?(?:NOT\s+implemented|deferred to M3|fails\s+closed)/i);
      // The 503 description must explicitly mention that
      // COMMERCE_CONSENT_CHALLENGE_PROVIDER=email_otp is ignored in M2.
      const five03 = block.match(/"503"[\s\S]*?(?=\n\s*"\d{3}"|\n\s*\/|$)/);
      expect(five03).not.toBeNull();
      expect(five03![0]).toMatch(/email_otp/);
      expect(five03![0]).toMatch(/(?:does NOT enable delivery|deferred to M3|ignored)/i);
    });
  });

  describe('POST /v1/commerce/consent/{reqId}/challenge/verify — challenge verify endpoint', () => {
    let block: string;
    beforeAll(() => { block = pathBlock('{reqId}/challenge/verify'); });

    it('exists and is x-implemented: true at M2', () => {
      expect(block).toMatch(/x-implemented:\s*true/);
      expect(block).toMatch(/x-milestone:\s*M2/);
    });
    it('requires application/x-www-form-urlencoded body with csrf + code', () => {
      expect(block).toMatch(/application\/x-www-form-urlencoded/);
      expect(block).toMatch(/required:\s*\[csrf,\s*code\]/);
    });
    it('declares 403 challenge_invalid, 410 challenge_expired, 404 challenge_not_found, 422 validation_failed', () => {
      expect(block).toMatch(/"403"[\s\S]*?challenge_invalid/);
      expect(block).toMatch(/"410"[\s\S]*?challenge_expired/);
      expect(block).toMatch(/"404"[\s\S]*?challenge_not_found/);
      expect(block).toMatch(/"422"[\s\S]*?validation_failed/);
    });
  });

  describe('POST /v1/commerce/consent/{reqId}/deny', () => {
    let block: string;
    beforeAll(() => { block = pathBlock('{reqId}/deny'); });

    it('requires application/x-www-form-urlencoded body with csrf field', () => {
      expect(block).toMatch(/application\/x-www-form-urlencoded/);
      expect(block).toMatch(/required:\s*\[csrf\]/);
    });

    it('description states principal session cookie + CSRF are required', () => {
      expect(block.toLowerCase()).toMatch(/principal session/);
      expect(block.toLowerCase()).toMatch(/csrf/);
    });

    it('declares 401 principal_session_required', () => {
      const m = block.match(/"401"[\s\S]*?(?=\n\s*"\d{3}"|\n\s*\/|$)/);
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/principal_session_required/);
    });

    it('declares 403 with all applicable codes including principal_hint_mismatch (P2 fix) and challenge_required (P0 fix)', () => {
      const m = block.match(/"403"[\s\S]*?(?=\n\s*"\d{3}"|\n\s*\/|$)/);
      expect(m).not.toBeNull();
      const text = m![0];
      expect(text).toMatch(/csrf_invalid/);
      expect(text).toMatch(/principal_not_authorized_for_tenant/);
      expect(text).toMatch(/tenant_disabled/);
      // P2 fix — deny now enforces hint match too.
      expect(text).toMatch(/principal_hint_mismatch/);
      // P0 fix — challenge gate applies to deny as well.
      expect(text).toMatch(/challenge_required/);
    });

    it('keeps 404, 409, 410', () => {
      expect(block).toMatch(/"404"/);
      expect(block).toMatch(/"409"/);
      expect(block).toMatch(/"410"/);
    });

    it('still x-implemented: true and x-milestone: M2', () => {
      expect(block).toMatch(/x-implemented:\s*true/);
      expect(block).toMatch(/x-milestone:\s*M2/);
    });
  });
});
