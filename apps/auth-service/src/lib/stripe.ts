import Stripe from 'stripe';
import { config } from '../config.js';

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    if (!config.stripeSecretKey) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    const stripeConfig = {
      // The installed Stripe SDK type union lags this pinned account/API version.
      apiVersion: '2026-06-24.dahlia',
    } as unknown as ConstructorParameters<typeof Stripe>[1];
    _stripe = new Stripe(config.stripeSecretKey, stripeConfig);
  }
  return _stripe;
}
