import { GrantexTokenError } from '@grantex/sdk';
import type { Grantex } from '@grantex/sdk';
import type { CurrentGrantVerifier } from './guard.js';

/** No positive cache: every protected request consults the trusted issuer. */
export function grantexCurrentGrantVerifier(grantex: Pick<Grantex, 'grants'>): CurrentGrantVerifier {
  return {
    async verify(token) {
      try {
        await grantex.grants.verify(token);
        return true;
      } catch (error) {
        if (error instanceof GrantexTokenError) return false;
        throw error;
      }
    },
  };
}
