import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { commerceErrorHandler, CommerceHttpError } from '../lib/commerce/errors.js';
import {
  commercePublicDiscoveryMerchantAllowlist,
  isCommercePublicDiscoveryEnabled,
} from '../lib/commerce/public-discovery.js';
import {
  readMerchantPublishingProfile,
  V1_COMMERCE_REQUIRED_SCOPES,
  V1_COMMERCE_TOOLS,
} from '../lib/commerce/catalog.js';

function isCommerceV1Enabled(): boolean {
  return process.env['COMMERCE_V1_ENABLED'] === 'true';
}

function publicUrl(path: string): string {
  return new URL(path, config.publicBaseUrl).toString();
}

function resolvePublicDiscoveryMerchantId(requestedMerchantId: string | null): string {
  const allowlist = commercePublicDiscoveryMerchantAllowlist();
  if (allowlist.length === 0) {
    throw new CommerceHttpError(503, 'commerce_public_discovery_allowlist_required',
      'Commerce public discovery requires an allowlisted merchant', { retryable: false });
  }
  if (!requestedMerchantId && allowlist.length > 1) {
    throw new CommerceHttpError(422, 'merchant_selector_required',
      'Multiple commerce merchants are available; pass ?merchant_id=...');
  }
  const merchantId = requestedMerchantId ?? allowlist[0];
  if (!merchantId || !allowlist.includes(merchantId)) {
    throw new CommerceHttpError(404, 'merchant_not_found',
      'Merchant publishing profile was not found');
  }
  return merchantId;
}

function assertPublicDiscoveryLiveFlagsDisabled(): void {
  if (process.env['COMMERCE_LIVE_MODE_ENABLED'] === 'true' || process.env['PLURAL_LIVE_ENABLED'] === 'true') {
    throw new CommerceHttpError(503, 'commerce_public_discovery_live_flags_forbidden',
      'Commerce public discovery requires live payment and live Plural flags to remain disabled',
      { retryable: false });
  }
}

export async function commerceWellKnownRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(commerceErrorHandler);

  app.get<{ Querystring: { merchant_id?: string } }>(
    '/.well-known/grantex-commerce',
    { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      const commerceV1Enabled = isCommerceV1Enabled();
      const publicDiscoveryEnabled = isCommercePublicDiscoveryEnabled();
      if (!commerceV1Enabled && !publicDiscoveryEnabled) {
        throw new CommerceHttpError(503, 'commerce_disabled',
          'Grantex Commerce V1 is not enabled in this environment', { retryable: false });
      }
      const requestedMerchantId = typeof request.query.merchant_id === 'string' && request.query.merchant_id.length > 0
        ? request.query.merchant_id
        : null;
      let merchantId = requestedMerchantId;
      if (publicDiscoveryEnabled) {
        assertPublicDiscoveryLiveFlagsDisabled();
        merchantId = resolvePublicDiscoveryMerchantId(requestedMerchantId);
      }
      const result = await readMerchantPublishingProfile(getSql(), { merchantId });
      if (result.kind === 'not_found') {
        throw new CommerceHttpError(404, 'merchant_not_found',
          'Merchant publishing profile was not found');
      }
      if (result.kind === 'selector_required') {
        throw new CommerceHttpError(422, 'merchant_selector_required',
          'Multiple commerce merchants are available; pass ?merchant_id=...');
      }
      const livePaymentsEnabled = process.env['COMMERCE_LIVE_MODE_ENABLED'] === 'true';
      const livePluralEnabled = process.env['PLURAL_LIVE_ENABLED'] === 'true';
      const checkoutPaymentRuntimeEnabled = commerceV1Enabled && livePaymentsEnabled;

      return reply.status(200).send({
        version: 'grantex-commerce-v1',
        merchant: result.profile,
        environment: result.profile.environment,
        supported_tools: [...V1_COMMERCE_TOOLS],
        auth_requirements: {
          public_browse: false,
          public_browse_status: 'deferred_until_publish_flag_exists',
          commerce_agent_auth: true,
          merchant_api_key_auth: true,
          checkout_passport_required_for_payment: true,
        },
        required_scopes: V1_COMMERCE_REQUIRED_SCOPES,
        mcp: {
          transport: 'streamable_http',
          url: publicUrl('/mcp'),
        },
        native_rest: {
          base_url: publicUrl('/v1/commerce'),
        },
        capabilities: result.profile.capabilities,
        discovery_posture: {
          mode: publicDiscoveryEnabled ? 'public_read_only_discovery' : 'commerce_v1_runtime_discovery',
          read_only_discovery_only: publicDiscoveryEnabled && !commerceV1Enabled,
          commerce_v1_runtime_enabled: commerceV1Enabled,
          checkout_payment_creation_enabled_by_discovery_gate: checkoutPaymentRuntimeEnabled,
          live_payments_enabled: livePaymentsEnabled,
          live_plural_enabled: livePluralEnabled,
          provider_credentials_exposed: false,
          readiness_claim: 'none',
          certification_claim: 'none',
          notes: [
            'COMMERCE_PUBLIC_DISCOVERY_ENABLED publishes metadata only.',
            'Checkout and payment creation require separate Commerce V1 runtime approval.',
            livePaymentsEnabled && livePluralEnabled
              ? 'Live Commerce and live Plural runtime flags are enabled for approved authenticated flows.'
              : 'Live payments and live Plural remain disabled by this discovery gate.',
            'This profile makes no production-readiness or certification claim.',
          ],
        },
      });
    },
  );
}
