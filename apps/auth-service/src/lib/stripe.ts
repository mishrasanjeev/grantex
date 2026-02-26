import Stripe from 'stripe';
import { config } from '../config.js';

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    if (!config.stripeSecretKey) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    _stripe = new Stripe(config.stripeSecretKey, {
      apiVersion: '2026-02-25.clover',
    });
  }
  return _stripe;
}
