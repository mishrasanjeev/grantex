import type { AdapterConfig, AdapterResult, ListPaymentIntentsParams, CreatePaymentIntentParams } from '../types.js';
import { BaseAdapter } from '../base-adapter.js';
import { enforceConstraint } from '../scope-utils.js';
import { GrantexAdapterError } from '../errors.js';

const STRIPE_API = 'https://api.stripe.com/v1';

export class StripeAdapter extends BaseAdapter {
  constructor(config: AdapterConfig) {
    super(config);
  }

  async listPaymentIntents(
    token: string,
    params: ListPaymentIntentsParams = {},
  ): Promise<AdapterResult> {
    const { grant } = await this.verifyAndCheckScope(token, 'payments:read');
    const credential = await this.resolveCredential();

    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.customer) query.set('customer', params.customer);
    if (params.starting_after) query.set('starting_after', params.starting_after);

    const qs = query.toString();
    const url = `${STRIPE_API}/payment_intents${qs ? `?${qs}` : ''}`;

    try {
      const data = await this.callUpstream(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
      });
      await this.logAudit(grant, 'payments:listPaymentIntents', 'success');
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'payments:listPaymentIntents', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Stripe list failed: ${String(err)}`);
    }
  }

  async createPaymentIntent(
    token: string,
    params: CreatePaymentIntentParams,
  ): Promise<AdapterResult> {
    const { grant, matchedScope } = await this.verifyAndCheckScope(token, 'payments:initiate');
    const credential = await this.resolveCredential();

    // Enforce constraint: max_500 means max $500 = max 50000 cents
    // The constraint value is in dollars, params.amount is in cents
    if (matchedScope.constraint) {
      const amountInDollars = params.amount / 100;
      const result = enforceConstraint(matchedScope, amountInDollars);
      if (!result.allowed) {
        await this.logAudit(grant, 'payments:createPaymentIntent', 'blocked', {
          amount: params.amount,
          constraint: matchedScope.constraint,
        });
        throw new GrantexAdapterError('CONSTRAINT_VIOLATED', result.reason!);
      }
    }

    const formData = new URLSearchParams();
    formData.set('amount', String(params.amount));
    formData.set('currency', params.currency);
    if (params.customer) formData.set('customer', params.customer);
    if (params.description) formData.set('description', params.description);
    if (params.metadata) {
      for (const [key, value] of Object.entries(params.metadata)) {
        formData.set(`metadata[${key}]`, value);
      }
    }

    const url = `${STRIPE_API}/payment_intents`;

    try {
      const data = await this.callUpstream(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });
      await this.logAudit(grant, 'payments:createPaymentIntent', 'success', {
        amount: params.amount,
        currency: params.currency,
      });
      return this.wrapResult(grant, data);
    } catch (err) {
      await this.logAudit(grant, 'payments:createPaymentIntent', 'failure');
      if (err instanceof GrantexAdapterError) throw err;
      throw new GrantexAdapterError('UPSTREAM_ERROR', `Stripe create failed: ${String(err)}`);
    }
  }
}
