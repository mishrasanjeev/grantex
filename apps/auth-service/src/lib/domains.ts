/**
 * Custom domain DNS verification.
 *
 * Verifies domain ownership via DNS TXT record: _grantex.{domain} = {verificationToken}
 */

import { resolve } from 'node:dns/promises';

/**
 * Verify a custom domain by checking for a DNS TXT record.
 *
 * Expects: TXT record at `_grantex.{domain}` containing the verification token.
 */
export async function verifyDomainDns(
  domain: string,
  expectedToken: string,
): Promise<boolean> {
  try {
    const records = await resolve(`_grantex.${domain}`, 'TXT');
    // DNS TXT records come as arrays of string chunks
    for (const record of records) {
      const value = Array.isArray(record) ? record.join('') : String(record);
      if (value === expectedToken) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
