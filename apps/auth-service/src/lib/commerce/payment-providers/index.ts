import { MockPaymentProvider } from './mock.js';
import { PluralPaymentProvider } from './plural.js';
import type { PaymentProvider, ProviderKey } from './types.js';

export function getPaymentProvider(providerKey: ProviderKey): PaymentProvider {
  if (providerKey === 'mock') return new MockPaymentProvider();
  return new PluralPaymentProvider();
}

export * from './types.js';
export { MockPaymentProvider } from './mock.js';
export { PluralPaymentProvider } from './plural.js';

