import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { commerceErrorHandler, CommerceHttpError } from '../lib/commerce/errors.js';
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

export async function commerceWellKnownRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(commerceErrorHandler);

  app.get<{ Querystring: { merchant_id?: string } }>(
    '/.well-known/grantex-commerce',
    { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isCommerceV1Enabled()) {
        throw new CommerceHttpError(503, 'commerce_disabled',
          'Grantex Commerce V1 is not enabled in this environment', { retryable: false });
      }
      const merchantId = typeof request.query.merchant_id === 'string' && request.query.merchant_id.length > 0
        ? request.query.merchant_id
        : null;
      const result = await readMerchantPublishingProfile(getSql(), { merchantId });
      if (result.kind === 'not_found') {
        throw new CommerceHttpError(404, 'merchant_not_found',
          'Merchant publishing profile was not found');
      }
      if (result.kind === 'selector_required') {
        throw new CommerceHttpError(422, 'merchant_selector_required',
          'Multiple commerce merchants are available; pass ?merchant_id=...');
      }

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
      });
    },
  );
}
