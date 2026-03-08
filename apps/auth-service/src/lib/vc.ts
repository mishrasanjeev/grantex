/**
 * W3C Verifiable Credentials (VC-JWT) issuance, verification, and StatusList2021.
 *
 * Uses the existing RS256 key pair from crypto.ts. VC-JWTs follow W3C VC Data
 * Model v2.0 with the JWT encoding specified in the VC-JWT specification.
 */

import { SignJWT, jwtVerify, decodeJwt } from 'jose';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getSql } from '../db/client.js';
import { getKeyPair } from './crypto.js';
import { newVerifiableCredentialId, newStatusListId } from './ids.js';
import { config } from '../config.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface IssueVCParams {
  grantId: string;
  agentDid: string;
  principalId: string;
  developerId: string;
  scopes: string[];
  expiresAt: Date;
  delegationDepth?: number;
  fidoEvidence?: Record<string, unknown>;
}

export interface VCPayload {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  vc: {
    '@context': string[];
    type: string[];
    credentialSubject: Record<string, unknown>;
    credentialStatus?: Record<string, unknown>;
    evidence?: Record<string, unknown>[];
  };
}

export interface VerifyVCResult {
  valid: boolean;
  vcId?: string;
  payload?: VCPayload;
  revoked?: boolean;
  expired?: boolean;
  error?: string;
}

// ── StatusList2021 helpers ──────────────────────────────────────────────────

const STATUS_LIST_SIZE = 131072; // bits
const STATUS_LIST_BYTES = Math.ceil(STATUS_LIST_SIZE / 8); // 16384

function createEmptyBitstring(): Buffer {
  return Buffer.alloc(STATUS_LIST_BYTES, 0);
}

function encodeBitstring(bitstring: Buffer): string {
  const compressed = gzipSync(bitstring);
  return compressed.toString('base64url');
}

function decodeBitstring(encoded: string): Buffer {
  const compressed = Buffer.from(encoded, 'base64url');
  return Buffer.from(gunzipSync(compressed));
}

function setBit(bitstring: Buffer, index: number): void {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = 7 - (index % 8); // MSB-first
  bitstring[byteIndex]! |= 1 << bitIndex;
}

function getBit(bitstring: Buffer, index: number): boolean {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = 7 - (index % 8);
  return ((bitstring[byteIndex]! >> bitIndex) & 1) === 1;
}

// ── StatusList management ───────────────────────────────────────────────────

export async function getOrCreateStatusList(
  developerId: string,
): Promise<{ id: string; nextIndex: number }> {
  const sql = getSql();

  // Try to find existing list
  const existing = await sql`
    SELECT id, next_index FROM vc_status_lists
    WHERE developer_id = ${developerId} AND purpose = 'revocation'
    LIMIT 1
  `;

  if (existing[0]) {
    return {
      id: existing[0]['id'] as string,
      nextIndex: Number(existing[0]['next_index']),
    };
  }

  // Create new status list
  const listId = newStatusListId();
  const emptyBitstring = createEmptyBitstring();
  const encoded = encodeBitstring(emptyBitstring);

  await sql`
    INSERT INTO vc_status_lists (id, developer_id, purpose, encoded_list, size, next_index)
    VALUES (${listId}, ${developerId}, 'revocation', ${encoded}, ${STATUS_LIST_SIZE}, 0)
  `;

  return { id: listId, nextIndex: 0 };
}

// ── VC-JWT issuance ─────────────────────────────────────────────────────────

export async function issueAgentGrantVC(params: IssueVCParams): Promise<{
  vcId: string;
  vcJwt: string;
  statusListIdx: number;
}> {
  const {
    grantId,
    agentDid,
    principalId,
    developerId,
    scopes,
    expiresAt,
    delegationDepth = 0,
    fidoEvidence,
  } = params;

  const vcId = newVerifiableCredentialId();
  const { privateKey, kid } = getKeyPair();
  const domain = config.didWebDomain;
  const issuerDid = `did:web:${domain}`;

  // Get or create status list and allocate an index
  const statusList = await getOrCreateStatusList(developerId);
  const statusListIdx = statusList.nextIndex;

  // Increment next_index
  const sql = getSql();
  await sql`
    UPDATE vc_status_lists SET next_index = next_index + 1, updated_at = NOW()
    WHERE id = ${statusList.id}
  `;

  // Build VC payload
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.floor(expiresAt.getTime() / 1000);

  const credentialSubject: Record<string, unknown> = {
    id: agentDid,
    type: 'AIAgent',
    principalId,
    developerId,
    grantId,
    scopes,
    delegationDepth,
  };

  const credentialStatus = {
    id: `${config.jwtIssuer}/v1/credentials/status/${statusList.id}#${statusListIdx}`,
    type: 'StatusList2021Entry',
    statusPurpose: 'revocation',
    statusListIndex: String(statusListIdx),
    statusListCredential: `${config.jwtIssuer}/v1/credentials/status/${statusList.id}`,
  };

  const evidence: Record<string, unknown>[] = [];
  if (fidoEvidence) {
    evidence.push({
      type: 'FidoAttestation',
      ...fidoEvidence,
    });
  }

  const vcClaim: VCPayload['vc'] = {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://grantex.dev/ns/credentials/v1',
    ],
    type: ['VerifiableCredential', 'AgentGrantCredential'],
    credentialSubject,
    credentialStatus,
    ...(evidence.length > 0 ? { evidence } : {}),
  };

  // Sign the VC-JWT
  const vcJwt = await new SignJWT({ vc: vcClaim })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(issuerDid)
    .setSubject(agentDid)
    .setJti(vcId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);

  // Store in database
  await sql`
    INSERT INTO verifiable_credentials (
      id, grant_id, developer_id, principal_id, agent_did,
      credential_type, format, credential_jwt, status,
      status_list_idx, expires_at
    )
    VALUES (
      ${vcId}, ${grantId}, ${developerId}, ${principalId}, ${agentDid},
      'AgentGrantCredential', 'vc-jwt', ${vcJwt}, 'active',
      ${statusListIdx}, ${expiresAt}
    )
  `;

  return { vcId, vcJwt, statusListIdx };
}

// ── VC-JWT verification ─────────────────────────────────────────────────────

export async function verifyAgentGrantVC(vcJwt: string): Promise<VerifyVCResult> {
  const { publicKey } = getKeyPair();

  // Decode first to extract claims without full verification (for error reporting)
  let decoded: Record<string, unknown>;
  try {
    decoded = decodeJwt(vcJwt) as Record<string, unknown>;
  } catch {
    return { valid: false, error: 'Invalid JWT format' };
  }

  const vcId = decoded['jti'] as string | undefined;
  const vcIdFields = vcId !== undefined ? { vcId } : {};

  // Verify signature and expiry
  try {
    await jwtVerify(vcJwt, publicKey, {
      algorithms: ['RS256'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    if (message.includes('exp') || message.includes('expired')) {
      return { valid: false, ...vcIdFields, expired: true, error: 'Credential expired' };
    }
    return { valid: false, ...vcIdFields, error: message };
  }

  // Check structure
  const vc = decoded['vc'] as Record<string, unknown> | undefined;
  if (!vc) {
    return { valid: false, ...vcIdFields, error: 'Missing vc claim' };
  }

  // Check revocation via status list
  const credentialStatus = vc['credentialStatus'] as Record<string, unknown> | undefined;
  if (credentialStatus) {
    const statusListIdx = parseInt(credentialStatus['statusListIndex'] as string, 10);
    const statusListUrl = credentialStatus['statusListCredential'] as string;

    // Extract list ID from URL
    const listIdMatch = statusListUrl?.match(/\/status\/([^/#]+)/);
    if (listIdMatch) {
      const listId = listIdMatch[1]!;
      const sql = getSql();
      const listRows = await sql`
        SELECT encoded_list FROM vc_status_lists WHERE id = ${listId}
      `;

      if (listRows[0]) {
        const bitstring = decodeBitstring(listRows[0]['encoded_list'] as string);
        if (getBit(bitstring, statusListIdx)) {
          return {
            valid: false,
            ...vcIdFields,
            revoked: true,
            error: 'Credential has been revoked',
            payload: decoded as unknown as VCPayload,
          };
        }
      }
    }
  }

  return {
    valid: true,
    ...vcIdFields,
    payload: decoded as unknown as VCPayload,
  };
}

// ── VC revocation ───────────────────────────────────────────────────────────

export async function revokeVCsByGrantIds(
  grantIds: string[],
  developerId: string,
): Promise<void> {
  if (grantIds.length === 0) return;

  const sql = getSql();

  // Find all active VCs for these grants
  const vcRows = await sql`
    SELECT id, status_list_idx FROM verifiable_credentials
    WHERE grant_id = ANY(${grantIds})
      AND developer_id = ${developerId}
      AND status = 'active'
  `;

  if (vcRows.length === 0) return;

  // Mark VCs as revoked
  const vcIds = vcRows.map((r) => r['id'] as string);
  await sql`
    UPDATE verifiable_credentials
    SET status = 'revoked', revoked_at = NOW()
    WHERE id = ANY(${vcIds})
  `;

  // Flip bits in the status list
  const listRows = await sql`
    SELECT id, encoded_list FROM vc_status_lists
    WHERE developer_id = ${developerId} AND purpose = 'revocation'
    LIMIT 1
  `;

  if (listRows[0]) {
    const listId = listRows[0]['id'] as string;
    const bitstring = decodeBitstring(listRows[0]['encoded_list'] as string);

    for (const row of vcRows) {
      const idx = Number(row['status_list_idx']);
      if (idx >= 0 && idx < STATUS_LIST_SIZE) {
        setBit(bitstring, idx);
      }
    }

    const encoded = encodeBitstring(bitstring);
    await sql`
      UPDATE vc_status_lists SET encoded_list = ${encoded}, updated_at = NOW()
      WHERE id = ${listId}
    `;
  }
}

// ── StatusList2021 credential builder ───────────────────────────────────────

export async function buildStatusListCredential(
  listId: string,
): Promise<Record<string, unknown> | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, developer_id, encoded_list, purpose, size, updated_at
    FROM vc_status_lists WHERE id = ${listId}
  `;

  const list = rows[0];
  if (!list) return null;

  const domain = config.didWebDomain;
  const issuerDid = `did:web:${domain}`;

  return {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://w3id.org/vc/status-list/2021/v1',
    ],
    id: `${config.jwtIssuer}/v1/credentials/status/${list['id'] as string}`,
    type: ['VerifiableCredential', 'StatusList2021Credential'],
    issuer: issuerDid,
    issued: (list['updated_at'] as Date).toISOString(),
    credentialSubject: {
      id: `${config.jwtIssuer}/v1/credentials/status/${list['id'] as string}#list`,
      type: 'StatusList2021',
      statusPurpose: list['purpose'] as string,
      encodedList: list['encoded_list'] as string,
    },
  };
}
