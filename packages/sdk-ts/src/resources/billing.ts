import type { HttpClient } from '../http.js';
import type {
  CheckoutResponse,
  CreateCheckoutParams,
  CreatePortalParams,
  PortalResponse,
  SubscriptionStatus,
} from '../types.js';

export class BillingClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Get the current subscription status for the authenticated developer. */
  getSubscription(): Promise<SubscriptionStatus> {
    return this.#http.get<SubscriptionStatus>('/v1/billing/subscription');
  }

  /** Create a Stripe Checkout session and return the redirect URL. */
  createCheckout(params: CreateCheckoutParams): Promise<CheckoutResponse> {
    return this.#http.post<CheckoutResponse>('/v1/billing/checkout', params);
  }

  /** Create a Stripe Billing Portal session and return the redirect URL. */
  createPortal(params: CreatePortalParams): Promise<PortalResponse> {
    return this.#http.post<PortalResponse>('/v1/billing/portal', params);
  }
}
