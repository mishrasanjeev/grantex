// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Payment rails a PaymentMandate may name (`payment.rail`, the AP2
 * `payment_instrument.type` role). Provider-specific names live here, in the
 * provider directory, so the mandate core stays provider-neutral: `plural`
 * (the Plural payment rail), `upi_autopay` (a UPI AutoPay mandate), and
 * `card_network_token` (a card network token).
 */
export const OACP_PAYMENT_RAILS = ['plural', 'upi_autopay', 'card_network_token'] as const;
export type OacpPaymentRail = typeof OACP_PAYMENT_RAILS[number];

/**
 * Providers whose mandate-capability verifier AgenticOrg runs and whose
 * redacted evidence Grantex binds into the `mandate_capability` artifact
 * (G43). `plural_pine` is the provider value of the AgenticOrg Plural capability
 * verifier.
 */
export const MANDATE_CAPABILITY_PROVIDERS = ['plural_pine'] as const;
export type MandateCapabilityProvider = typeof MANDATE_CAPABILITY_PROVIDERS[number];
