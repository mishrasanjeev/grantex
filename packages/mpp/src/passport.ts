import type { Grantex } from '@grantex/sdk';
import type {
  IssuePassportOptions,
  IssuePassportResponse,
  IssuedPassport,
} from './types.js';
import { ALL_MPP_CATEGORIES } from './category-mapping.js';

const MAX_EXPIRY_HOURS = 720; // 30 days

function parseExpiresIn(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)(h|m|s|d)$/);
  if (!match) {
    throw new Error(`Invalid expiresIn format: ${expiresIn}. Use e.g. '24h', '30d', '60m'`);
  }
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  switch (unit) {
    case 'h': return value;
    case 'd': return value * 24;
    case 'm': return value / 60;
    case 's': return value / 3600;
    default: throw new Error(`Unknown time unit: ${unit}`);
  }
}

/**
 * Issue a new AgentPassportCredential via the Grantex auth service.
 *
 * Internally calls the `POST /v1/passport/issue` endpoint.
 */
export async function issuePassport(
  client: Grantex,
  options: IssuePassportOptions,
): Promise<IssuedPassport> {
  // Validate categories
  const invalidCategories = options.allowedMPPCategories.filter(
    (c) => !ALL_MPP_CATEGORIES.includes(c),
  );
  if (invalidCategories.length > 0) {
    throw new Error(`Invalid MPP categories: ${invalidCategories.join(', ')}`);
  }

  // Validate expiry
  const expiresIn = options.expiresIn ?? '24h';
  const expiryHours = parseExpiresIn(expiresIn);
  if (expiryHours > MAX_EXPIRY_HOURS) {
    throw new Error(`expiresIn exceeds maximum of ${MAX_EXPIRY_HOURS} hours (30 days)`);
  }

  // Call the auth service — uses the internal HttpClient from the SDK
  // We access the SDK's underlying HTTP layer via a passports.issue() method,
  // but since we're a separate package, we use the SDK's generic HTTP capabilities.
  // The SDK exposes an internal _http for peer packages, or we call fetch directly.
  const baseUrl = (client as unknown as { _baseUrl?: string })._baseUrl ?? 'https://api.grantex.dev';
  const apiKey = (client as unknown as { _apiKey?: string })._apiKey ?? '';

  const body = {
    agentId: options.agentId,
    grantId: options.grantId,
    allowedMPPCategories: options.allowedMPPCategories,
    maxTransactionAmount: options.maxTransactionAmount,
    ...(options.paymentRails !== undefined ? { paymentRails: options.paymentRails } : {}),
    expiresIn,
    ...(options.parentPassportId !== undefined ? { parentPassportId: options.parentPassportId } : {}),
  };

  const response = await fetch(`${baseUrl}/v1/passport/issue`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as { message?: string; code?: string } | null;
    const message = errorBody?.message ?? `Failed to issue passport: ${response.status}`;
    throw new Error(message);
  }

  const result = (await response.json()) as IssuePassportResponse;

  return {
    passportId: result.passportId,
    credential: result.credential,
    encodedCredential: result.encodedCredential,
    expiresAt: new Date(result.expiresAt),
  };
}
