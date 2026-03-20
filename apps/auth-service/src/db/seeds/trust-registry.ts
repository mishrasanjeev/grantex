import { getSql } from '../client.js';
import { ulid } from 'ulid';

export const DEMO_ORGS = [
  { organizationDID: 'did:web:pinelabs.com', domain: 'pinelabs.com', trustLevel: 'soc2', verificationMethod: 'soc2' },
  { organizationDID: 'did:web:acme-demo.dev', domain: 'acme-demo.dev', trustLevel: 'verified', verificationMethod: 'dns-txt' },
  { organizationDID: 'did:web:shopify.com', domain: 'shopify.com', trustLevel: 'verified', verificationMethod: 'manual' },
  { organizationDID: 'did:web:doordash.com', domain: 'doordash.com', trustLevel: 'verified', verificationMethod: 'manual' },
  { organizationDID: 'did:web:grantex.dev', domain: 'grantex.dev', trustLevel: 'soc2', verificationMethod: 'soc2' },
] as const;

export async function seedTrustRegistry(): Promise<void> {
  const sql = getSql();

  for (const org of DEMO_ORGS) {
    const id = `treg_${ulid()}`;
    await sql`
      INSERT INTO trust_registry (id, organization_did, domain, trust_level, verification_method)
      VALUES (${id}, ${org.organizationDID}, ${org.domain}, ${org.trustLevel}, ${org.verificationMethod})
      ON CONFLICT (organization_did) DO NOTHING
    `;
  }
}
