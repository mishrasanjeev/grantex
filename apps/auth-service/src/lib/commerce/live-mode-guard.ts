/**
 * P0-23 — central Commerce live-mode guard.
 *
 * Every commerce handler that can create or advance live payment-provider
 * state must call {@link ensureCommerceLiveMode} as the first side-effect
 * gate. Read-only routes, sandbox-only routes, and the mock provider do
 * NOT need this gate — passing `environment: 'sandbox'` or
 * `providerKey: 'mock'` always resolves to allowed.
 *
 * The guard is fail-closed by default: live commerce side effects are
 * blocked unless `COMMERCE_LIVE_MODE_ENABLED=true` is explicitly set in
 * the deployment environment, and `PLURAL_LIVE_ENABLED=true` is also set
 * for Plural-specific live flows. This mirrors the existing scattered
 * env checks that were previously duplicated across
 *   - apps/auth-service/src/routes/commerce-cart-payment.ts
 *   - apps/auth-service/src/routes/commerce-provider-credentials.ts
 *   - apps/auth-service/src/routes/commerce-well-known.ts
 *   - apps/auth-service/src/lib/commerce/payment-providers/plural.ts
 *
 * Stable error contract (envelope shape comes from
 * {@link CommerceHttpError} → commerceErrorEnvelope):
 *   status 403
 *   code   'commerce_live_mode_disabled' | 'plural_live_disabled'
 *   retryable=false
 *   details.reason = one of the LiveModeBlockReason values
 *
 * Callers must NOT catch and translate this error — let it bubble to
 * the commerce error handler, which renders the spec §16 envelope.
 */

import { CommerceHttpError } from './errors.js';
import type { CommerceEnvironment, ProviderKey } from './payment-providers/index.js';

export type LiveModeBlockReason =
  | 'live_mode_disabled'
  | 'plural_live_disabled'
  | 'plural_sandbox_disabled';

export interface LiveModeStatus {
  /** COMMERCE_LIVE_MODE_ENABLED — master switch for any live commerce side effects. */
  liveModeEnabled: boolean;
  /** PLURAL_LIVE_ENABLED — Plural-specific live-mode authorization. */
  pluralLiveEnabled: boolean;
  /** PLURAL_SANDBOX_ENABLED — Plural sandbox enablement (separate from mock). */
  pluralSandboxEnabled: boolean;
}

export interface LiveModeRequest {
  /**
   * Environment of the resource the handler is about to touch. `sandbox`
   * is always allowed by the guard. Omit only for handlers that do not
   * yet know the environment (caller should fall back to fail-closed
   * before any side effect).
   */
  environment?: CommerceEnvironment;
  /**
   * Payment provider the handler is dispatching to. `mock` is always
   * allowed by the guard (it has no real money flow). `plural` requires
   * the provider-specific flag in addition to the master switch.
   */
  providerKey?: ProviderKey;
}

/**
 * Read the env flags ONCE per call. Tests use `vi.stubEnv` between
 * cases, so we resolve the values lazily rather than caching them at
 * module load.
 */
export function getCommerceLiveModeStatus(): LiveModeStatus {
  return {
    liveModeEnabled: process.env['COMMERCE_LIVE_MODE_ENABLED'] === 'true',
    pluralLiveEnabled: process.env['PLURAL_LIVE_ENABLED'] === 'true',
    pluralSandboxEnabled: process.env['PLURAL_SANDBOX_ENABLED'] === 'true',
  };
}

/**
 * True iff the request would cause a live commerce side effect that
 * requires the guard's permission. The mock provider never causes a
 * real side effect, so it short-circuits to `false` regardless of the
 * environment label. Plural always needs the guard.
 */
export function isLiveCommerceSideEffect(req: LiveModeRequest): boolean {
  if (req.providerKey === 'mock') return false;
  if (req.providerKey === 'plural') return true;
  return req.environment === 'live';
}

/**
 * Throw a structured 403 if the requested commerce side effect is not
 * authorized in this deployment. Returns void on success.
 *
 * Decision matrix (preserves the historical per-handler behaviour the
 * existing test suite asserts):
 *
 *   provider=mock,  any environment      → allowed (mock has no real side effect)
 *   provider=plural, environment=live    → requires COMMERCE_LIVE_MODE_ENABLED
 *                                          AND PLURAL_LIVE_ENABLED
 *   provider=plural, environment=sandbox → requires PLURAL_SANDBOX_ENABLED
 *   provider undefined, env=live         → requires COMMERCE_LIVE_MODE_ENABLED
 *   provider undefined, env=sandbox      → allowed
 *   provider undefined, env undefined    → defaults to live → master flag required
 */
export function ensureCommerceLiveMode(req: LiveModeRequest = {}): void {
  const status = getCommerceLiveModeStatus();
  const providerKey = req.providerKey;
  const environment: CommerceEnvironment = req.environment ?? 'live';

  // Mock provider — no real money flow, always permitted.
  if (providerKey === 'mock') return;

  if (providerKey === 'plural') {
    if (environment === 'sandbox') {
      if (!status.pluralSandboxEnabled) {
        throw new CommerceHttpError(
          403,
          'plural_live_disabled',
          'Plural sandbox is disabled pending integration confirmation',
          {
            retryable: false,
            details: {
              reason: 'plural_sandbox_disabled' satisfies LiveModeBlockReason,
              remediation: 'Set PLURAL_SANDBOX_ENABLED=true after integration sign-off.',
              provider_key: 'plural',
            },
          },
        );
      }
      return;
    }
    // environment === 'live'
    if (!status.liveModeEnabled || !status.pluralLiveEnabled) {
      throw new CommerceHttpError(
        403,
        'plural_live_disabled',
        'Plural live mode is disabled pending legal, partner, and production '
          + 'readiness review',
        {
          retryable: false,
          details: {
            reason: 'plural_live_disabled' satisfies LiveModeBlockReason,
            remediation: 'Set both COMMERCE_LIVE_MODE_ENABLED=true and '
              + 'PLURAL_LIVE_ENABLED=true after Plural production sign-off.',
            provider_key: 'plural',
          },
        },
      );
    }
    return;
  }

  // No provider specified: gate solely on the master switch.
  if (environment === 'sandbox') return;
  if (!status.liveModeEnabled) {
    throw new CommerceHttpError(
      403,
      'commerce_live_mode_disabled',
      'Live commerce side effects are disabled pending legal, compliance, '
        + 'security, operations, and provider approvals',
      {
        retryable: false,
        details: {
          reason: 'live_mode_disabled' satisfies LiveModeBlockReason,
          remediation: 'Set COMMERCE_LIVE_MODE_ENABLED=true after the readiness gate is signed off.',
          ...(providerKey !== undefined ? { provider_key: providerKey } : {}),
        },
      },
    );
  }
}
