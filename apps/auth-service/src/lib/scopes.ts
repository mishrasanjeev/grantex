export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'calendar:read': 'Read your calendar events',
  'calendar:write': 'Create, modify, and delete your calendar events',
  'email:read': 'Read your email messages',
  'email:send': 'Send emails on your behalf',
  'email:delete': 'Delete your email messages',
  'files:read': 'Read your files and documents',
  'files:write': 'Create and modify your files',
  'payments:read': 'View your payment history and balances',
  'payments:initiate': 'Initiate payments of any amount',
  'profile:read': 'Read your profile and identity information',
  'contacts:read': 'Read your address book and contacts',
};

export function describeScope(scope: string): string {
  if (SCOPE_DESCRIPTIONS[scope]) return SCOPE_DESCRIPTIONS[scope];
  const maxMatch = /^payments:initiate:max_(\d+)$/.exec(scope);
  if (maxMatch) return `Initiate payments up to ${maxMatch[1]} in your account's base currency`;
  return scope;
}
