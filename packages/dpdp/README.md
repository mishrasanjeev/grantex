# @grantex/dpdp

[![npm version](https://img.shields.io/npm/v/@grantex/dpdp.svg)](https://www.npmjs.com/package/@grantex/dpdp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

**DPDP Act 2023 & EU AI Act compliance module for AI agents using the [Grantex](https://grantex.dev) authorization protocol.**

---

## Table of Contents

- [What is @grantex/dpdp?](#what-is-grantexdpdp)
- [Regulatory Coverage](#regulatory-coverage)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [1. Create a Consent Record](#1-create-a-consent-record)
  - [2. Enforce Purpose Limitation](#2-enforce-purpose-limitation)
  - [3. Withdraw Consent](#3-withdraw-consent)
  - [4. File a Grievance](#4-file-a-grievance)
  - [5. Export Compliance Reports](#5-export-compliance-reports)
- [API Reference](#api-reference)
  - [Consent Records](#consent-records)
  - [Consent Registry](#consent-registry)
  - [Consent Notices](#consent-notices)
  - [Withdrawal](#withdrawal)
  - [Purpose Registry](#purpose-registry)
  - [Purpose Enforcement](#purpose-enforcement)
  - [Data Principal Rights](#data-principal-rights)
  - [Grievances](#grievances)
  - [Compliance Exports](#compliance-exports)
  - [Regions](#regions)
  - [Errors](#errors)
- [Type Definitions](#type-definitions)
- [Security Considerations](#security-considerations)
- [Related Packages](#related-packages)
- [License](#license)

---

## What is @grantex/dpdp?

India's **Digital Personal Data Protection Act, 2023** (DPDP Act) and the **EU AI Act** impose
strict requirements on how personal data is collected, processed, and governed — especially when
AI agents act on behalf of humans.

`@grantex/dpdp` bridges the Grantex delegated authorization protocol with these regulations. It
provides a purpose-linked consent management layer, grievance redressal, data principal rights
enforcement, and machine-readable compliance exports that satisfy both Indian and European
regulatory requirements.

### Key capabilities

| Capability | Description |
|---|---|
| **Consent Records** | Immutable, Ed25519-signed consent records linked to Grantex grant tokens |
| **Purpose Enforcement** | Runtime checks that grant scopes satisfy declared processing purposes |
| **Consent Withdrawal** | Immediate withdrawal with optional grant revocation and data deletion |
| **Grievance Redressal** | File and track grievances per DPDP Act Section 13 |
| **Data Principal Rights** | Access, erasure, and portability APIs per Sections 11-13 |
| **DPDP Audit Export** | Structured export for Data Protection Board of India submissions |
| **GDPR Article 15 Export** | Machine-readable data subject access request response |
| **EU AI Act Conformance** | Conformance report covering Articles 9-15, 26, and 50 |
| **Region Configuration** | India (IN) and EU region-specific settings |

---

## Regulatory Coverage

### DPDP Act 2023 Mapping

| DPDP Section | Requirement | @grantex/dpdp Feature |
|---|---|---|
| Section 4 | Processing for lawful purpose | `enforcePurpose()` — runtime scope-to-purpose check |
| Section 5 | Notice to data principal | `createConsentNotice()` — versioned, hashed notices |
| Section 6 | Consent | `createConsentRecord()` — Ed25519-signed consent proof |
| Section 6(4) | Withdrawal of consent | `withdrawConsent()` — immediate, with grant revocation |
| Section 8(7) | Retention limitation | `retentionUntil` field on consent records |
| Section 11 | Right to information | `getDataPrincipalRecords()` — access API |
| Section 12 | Right to correction & erasure | `requestDataErasure()` — erasure request |
| Section 13 | Grievance redressal | `fileGrievance()` — 7-day resolution tracking |
| Section 17 | Record keeping | `requestDpdpExport()` — audit trail export |

### EU AI Act Mapping

| EU AI Act Article | Requirement | @grantex/dpdp Feature |
|---|---|---|
| Article 9 | Risk management | Covered in conformance report |
| Article 10 | Data governance | Purpose limitation + consent records |
| Article 11 | Technical documentation | Export includes system documentation |
| Article 12 | Record-keeping | Full audit trail with action logs |
| Article 13 | Transparency | Consent notices with purpose descriptions |
| Article 14 | Human oversight | Consent method tracking (explicit-click / api-delegated) |
| Article 15 | Accuracy & security | Ed25519 signatures, SHA-256 notice hashes |
| Article 26 | Deployer obligations | Compliance exports for deployers |
| Article 50 | GPAI transparency | Conformance report for general-purpose AI |

### GDPR Cross-Compliance

| GDPR Article | Requirement | @grantex/dpdp Feature |
|---|---|---|
| Article 6 | Lawful basis | `legalBasis` field on purposes |
| Article 7 | Conditions for consent | Signed consent proof with timestamp |
| Article 13-14 | Right to information | Consent notices with full disclosure |
| Article 15 | Right of access | `requestGdprExport()` — Article 15 export |
| Article 17 | Right to erasure | `requestDataErasure()` |
| Article 30 | Records of processing | `requestDpdpExport()` |

---

## Installation

```bash
npm install @grantex/dpdp @grantex/sdk
```

`@grantex/sdk` is a peer dependency. You must install it alongside `@grantex/dpdp`.

---

## Quick Start

### 1. Create a Consent Record

```typescript
import { createConsentRecord } from '@grantex/dpdp';

const record = await createConsentRecord({
  grantId: 'grant_abc123',
  dataPrincipalId: 'user_456',
  dataFiduciaryId: 'org_789',
  dataFiduciaryName: 'Acme Corp',
  purposes: [
    {
      purposeId: 'email-access',
      name: 'Email Access',
      description: 'Read and send emails on behalf of the user',
      legalBasis: 'consent',
      dataCategories: ['email', 'contacts'],
      retentionPeriod: '1 year',
      thirdPartySharing: false,
    },
  ],
  scopes: ['email:read', 'email:send'],
  consentNoticeId: 'notice_v1',
  consentNoticeContent: 'We will process your email data...',
  consentMethod: 'explicit-click',
  processingExpiresAt: new Date('2027-01-01'),
  retentionUntil: new Date('2028-01-01'),
  proofIpAddress: '192.168.1.1', // Stored as SHA-256 hash
  signingKey: ed25519PrivateKey,  // Optional Ed25519 CryptoKey
  apiKey: process.env.GRANTEX_API_KEY!,
  baseUrl: 'https://auth.grantex.dev',
});

console.log(record.recordId);        // 'rec_...'
console.log(record.consentNoticeHash); // SHA-256 hex string
console.log(record.consentProof.signature); // Ed25519 signature
```

### 2. Enforce Purpose Limitation

```typescript
import { PurposeRegistry, enforcePurpose } from '@grantex/dpdp';

const registry = new PurposeRegistry();

registry.register({
  purposeId: 'email-access',
  name: 'Email Access',
  description: 'Read and send emails on behalf of the user',
  requiredScopes: ['email:read', 'email:send'],
  legalBasis: 'consent',
  dataCategories: ['email', 'contacts'],
  retentionPeriod: '1 year',
  thirdPartySharing: false,
});

// This will throw PurposeViolationError if scopes are insufficient
enforcePurpose(
  ['email:read', 'email:send', 'calendar:read'], // grant scopes
  'email-access',                                  // purpose to enforce
  registry,
);
```

### 3. Withdraw Consent

```typescript
import { withdrawConsent } from '@grantex/dpdp';

const confirmation = await withdrawConsent(
  'rec_001',
  'User no longer wants email processing',
  {
    revokeGrant: true,           // Also revoke the Grantex grant token
    deleteProcessedData: true,   // Request data deletion
    apiKey: process.env.GRANTEX_API_KEY!,
    baseUrl: 'https://auth.grantex.dev',
  },
);

console.log(confirmation.status);       // 'withdrawn'
console.log(confirmation.grantRevoked); // true
console.log(confirmation.withdrawnAt);  // Date
```

### 4. File a Grievance

```typescript
import { fileGrievance } from '@grantex/dpdp';

const grievance = await fileGrievance(
  {
    dataPrincipalId: 'user_456',
    recordId: 'rec_001',
    type: 'unauthorized_processing',
    description: 'Agent accessed calendar data without consent',
    evidence: { auditEntries: ['audit_entry_789'] },
  },
  process.env.GRANTEX_API_KEY!,
  'https://auth.grantex.dev',
);

console.log(grievance.referenceNumber);       // 'GRV-2026-00042'
console.log(grievance.expectedResolutionBy);  // 7 days from now
```

### 5. Export Compliance Reports

```typescript
import {
  requestDpdpExport,
  requestGdprExport,
  requestEuAiActExport,
} from '@grantex/dpdp';

// DPDP Act audit export
const dpdp = await requestDpdpExport(
  {
    dateFrom: new Date('2026-01-01'),
    dateTo: new Date('2026-03-31'),
    format: 'json',
    includeActionLog: true,
    includeConsentRecords: true,
  },
  apiKey,
  baseUrl,
);

// GDPR Article 15 subject access request
const gdpr = await requestGdprExport(
  {
    dateFrom: new Date('2026-01-01'),
    dateTo: new Date('2026-03-31'),
    format: 'json',
    includeActionLog: true,
    includeConsentRecords: true,
    dataPrincipalId: 'user_456',
  },
  apiKey,
  baseUrl,
);

// EU AI Act conformance report
const euAiAct = await requestEuAiActExport(
  {
    dateFrom: new Date('2026-01-01'),
    dateTo: new Date('2026-03-31'),
    format: 'json',
    includeActionLog: true,
    includeConsentRecords: true,
  },
  apiKey,
  baseUrl,
);

console.log(euAiAct.downloadUrl); // Time-limited download URL (24h expiry)
```

---

## API Reference

### Consent Records

#### `createConsentRecord(options: CreateConsentRecordOptions): Promise<DPDPConsentRecord>`

Create a DPDP consent record linked to a Grantex grant token.

- Validates all mandatory purpose fields
- Computes SHA-256 hash of consent notice content
- Signs the record with Ed25519 if a signing key is provided
- IP addresses are stored as SHA-256 hashes (never plaintext)

#### `getConsentRecord(recordId: string, apiKey: string, baseUrl: string): Promise<DPDPConsentRecord>`

Fetch a single consent record by ID.

#### `listConsentRecords(principalId: string, apiKey: string, baseUrl: string): Promise<DPDPConsentRecord[]>`

List all consent records for a data principal.

---

### Consent Registry

#### `new ConsentRegistry()`

In-memory immutable consent registry with caching.

| Method | Description |
|---|---|
| `register(record)` | Register a consent record (immutable — cannot be re-registered) |
| `get(recordId)` | Get a consent record by ID |
| `listForPrincipal(principalId)` | List records for a data principal |
| `markWithdrawn(recordId, reason)` | Mark a record as withdrawn |
| `getStats()` | Get registry statistics |

---

### Consent Notices

#### `createConsentNotice(options: CreateConsentNoticeOptions): Promise<ConsentNotice>`

Register a versioned consent notice with the Grantex auth service.

#### `validateNotice(notice: ConsentNotice): string[]`

Validate a consent notice has all required fields. Returns an array of error strings (empty if valid).

#### `computeNoticeHash(content: string): Promise<string>`

Compute SHA-256 hash of consent notice content. Returns a hex-encoded string.

---

### Withdrawal

#### `withdrawConsent(recordId: string, reason: string, options: WithdrawConsentOptions): Promise<WithdrawalConfirmation>`

Withdraw consent for a consent record. Options:

| Option | Type | Description |
|---|---|---|
| `revokeGrant` | `boolean` | Also revoke the linked Grantex grant token |
| `deleteProcessedData` | `boolean` | Request deletion of data processed under this consent |
| `apiKey` | `string` | Grantex API key |
| `baseUrl` | `string` | Grantex auth service base URL |

---

### Purpose Registry

#### `new PurposeRegistry()`

Maps named purposes to required scopes.

| Method | Description |
|---|---|
| `register(purpose)` | Register a named purpose with required scopes |
| `get(purposeId)` | Get a registered purpose |
| `listAll()` | List all registered purposes |
| `getScopesForPurpose(purposeId)` | Get scopes required for a purpose |
| `toConsentPurpose(purposeId)` | Convert to a `ConsentPurpose` for consent records |

---

### Purpose Enforcement

#### `enforcePurpose(grantScopes: string[], purposeId: string, purposeRegistry: PurposeRegistry): void`

Check that a grant token's scopes satisfy a declared processing purpose.
Throws `PurposeViolationError` if scopes are insufficient.

#### `checkPurposeCompliance(record: DPDPConsentRecord): string[]`

Validate that a consent record has proper purpose definitions. Returns an array of
error strings (empty if compliant).

---

### Data Principal Rights

#### `getDataPrincipalRecords(principalId: string, apiKey: string, baseUrl: string): Promise<DataPrincipalRecords>`

Fetch all consent records belonging to a data principal (DPDP Section 11).

#### `requestDataErasure(principalId: string, apiKey: string, baseUrl: string): Promise<ErasureRequest>`

Submit a data erasure request for a data principal (DPDP Section 12).

---

### Grievances

#### `fileGrievance(params: FileGrievanceParams, apiKey: string, baseUrl: string): Promise<Grievance>`

File a grievance against a data fiduciary (DPDP Section 13).

#### `getGrievanceStatus(grievanceId: string, apiKey: string, baseUrl: string): Promise<Grievance>`

Check the status of a filed grievance.

#### `generateReferenceNumber(): string`

Generate a grievance reference number in format `GRV-YYYY-NNNNN`.

#### `calculateExpectedResolution(fromDate?: Date): Date`

Calculate the expected resolution date (7 calendar days from the given date).

---

### Compliance Exports

#### `requestDpdpExport(params, apiKey, baseUrl): Promise<ComplianceExportResult>`

Request a DPDP audit export containing consent records, action logs, and summary.

#### `requestGdprExport(params, apiKey, baseUrl): Promise<ComplianceExportResult>`

Request a GDPR Article 15 data subject access request export.

#### `requestEuAiActExport(params, apiKey, baseUrl): Promise<ComplianceExportResult>`

Request an EU AI Act conformance report covering all defined articles.

#### `getExportStatus(exportId, apiKey, baseUrl): Promise<ComplianceExportResult>`

Get the status and download URL of a previously requested export.

#### `EU_AI_ACT_ARTICLES`

Constant array of EU AI Act articles covered by the conformance report:

| Article | Title |
|---|---|
| 9 | Risk Management System |
| 10 | Data and Data Governance |
| 11 | Technical Documentation |
| 12 | Record-keeping |
| 13 | Transparency |
| 14 | Human Oversight |
| 15 | Accuracy, Robustness, Cybersecurity |
| 26 | Obligations of Deployers |
| 50 | Transparency for GPAI |

---

### Regions

#### `REGION_IN: RegionConfig`

India region configuration — DPDP Act settings, 11 supported languages.

#### `REGION_EU: RegionConfig`

European Union region configuration — GDPR + EU AI Act settings, 24 supported languages.

#### `REGIONS: Record<string, RegionConfig>`

All supported regions keyed by region code.

#### `getRegion(code: string): RegionConfig | undefined`

Get region config by region code (case-insensitive).

---

### Errors

All errors extend `DpdpError` and include a `code` string and optional `statusCode`.

| Error Class | Code | Description |
|---|---|---|
| `DpdpError` | (varies) | Base error class |
| `ConsentRequiredError` | `CONSENT_REQUIRED` | No consent record exists for the operation |
| `PurposeViolationError` | `PURPOSE_VIOLATION` | Grant scopes do not satisfy the required purpose |
| `WithdrawalError` | `WITHDRAWAL_ERROR` | Consent withdrawal failed |
| `GrievanceError` | `GRIEVANCE_ERROR` | Grievance filing or retrieval failed |
| `ExportError` | `EXPORT_ERROR` | Compliance export failed |

`PurposeViolationError` additionally exposes a `missingScopes: string[]` property.

---

## Type Definitions

### DPDPConsentRecord

```typescript
interface DPDPConsentRecord {
  recordId: string;
  grantId: string;
  dataPrincipalId: string;
  dataPrincipalDID?: string;
  dataFiduciaryId: string;
  dataFiduciaryName: string;
  purposes: ConsentPurpose[];
  scopes: string[];
  consentNoticeId: string;
  consentNoticeHash: string;            // SHA-256 of notice content
  consentGivenAt: Date;
  consentMethod: 'explicit-click' | 'api-delegated';
  processingExpiresAt: Date;
  retentionUntil: Date;
  consentProof: ConsentProof;
  status: 'active' | 'withdrawn' | 'expired';
  withdrawnAt?: Date;
  withdrawnReason?: string;
  lastAccessedAt?: Date;
  accessCount: number;
  actions: ConsentAction[];
}
```

### ConsentPurpose

```typescript
interface ConsentPurpose {
  purposeId: string;
  name: string;
  description: string;
  legalBasis: 'consent' | 'legitimate-interest' | 'contract';
  dataCategories: string[];
  retentionPeriod: string;
  thirdPartySharing: boolean;
  thirdParties?: string[];
}
```

### ConsentProof

```typescript
interface ConsentProof {
  ipAddress?: string;   // SHA-256 hash of IP (never plaintext)
  userAgent?: string;
  sessionId?: string;
  signedAt: Date;
  signature: string;    // Ed25519 over canonical record payload
}
```

### Grievance

```typescript
interface Grievance {
  grievanceId: string;
  dataPrincipalId: string;
  recordId: string;
  type: 'unauthorized_processing' | 'withdrawal_refused' | 'data_breach' | 'other';
  description: string;
  evidence?: { auditEntries?: string[] };
  status: 'submitted' | 'under_review' | 'resolved' | 'escalated';
  referenceNumber: string;              // GRV-YYYY-NNNNN
  expectedResolutionBy: Date;           // 7 calendar days
  resolvedAt?: Date;
  resolution?: string;
}
```

### ComplianceExportRequest

```typescript
interface ComplianceExportRequest {
  type: 'dpdp-audit' | 'gdpr-article-15' | 'eu-ai-act-conformance';
  dateFrom: Date;
  dateTo: Date;
  format: 'json' | 'csv';
  includeActionLog: boolean;
  includeConsentRecords: boolean;
  dataPrincipalId?: string;
}
```

### ComplianceExportResult

```typescript
interface ComplianceExportResult {
  exportId: string;
  type: string;
  status: 'complete';
  recordCount: number;
  data: unknown;
  downloadUrl?: string;
  downloadExpiresAt?: Date;             // 24-hour expiry
}
```

### RegionConfig

```typescript
interface RegionConfig {
  regionCode: string;
  regionName: string;
  dataResidencyRequired: boolean;
  consentMinAge: number;
  grievanceResolutionDays: number;
  defaultLanguage: string;
  supportedLanguages: string[];
  regulatoryAuthority: string;
  regulatoryUrl: string;
}
```

---

## Security Considerations

### Consent Record Integrity

Every consent record can be signed with an **Ed25519** key. The signature covers a canonical
JSON payload containing `grantId`, `dataPrincipalId`, `dataFiduciaryId`, `purposes`,
`scopes`, `consentNoticeHash`, and `consentGivenAt`. This makes consent records tamper-evident
and verifiable by any party holding the organization's public key.

### PII Protection

IP addresses provided in consent proofs are **hashed with SHA-256** before being sent to the
server. The raw IP address never leaves the client. Other PII fields like user agent strings
are stored as-is but can be omitted.

### Consent Notice Hashing

Consent notice content is hashed with **SHA-256** and stored alongside the consent record.
This ensures that any modification to the notice text after consent was given is detectable.

### Immutability

Consent records are immutable after creation. The `ConsentRegistry` enforces this by freezing
records and rejecting duplicate registrations. Withdrawal creates a new state transition
rather than modifying the original record.

### Data Isolation

The `ConsentRegistry.listForPrincipal()` method ensures a data principal can only access
their own records. Cross-principal access is prevented at both the client registry and
server API levels.

### Withdrawal Irreversibility

Once consent is withdrawn, it cannot be undone through the API. A new consent record must
be created if processing is to resume.

---

## Related Packages

| Package | Description |
|---|---|
| [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) | Core TypeScript SDK for Grantex |
| [`@grantex/express`](https://www.npmjs.com/package/@grantex/express) | Express.js middleware |
| [`@grantex/gateway`](https://www.npmjs.com/package/@grantex/gateway) | Reverse-proxy gateway |
| [`@grantex/mcp`](https://www.npmjs.com/package/@grantex/mcp) | MCP server for Claude Desktop |
| [`@grantex/langchain`](https://www.npmjs.com/package/@grantex/langchain) | LangChain integration |
| [`@grantex/vercel-ai`](https://www.npmjs.com/package/@grantex/vercel-ai) | Vercel AI SDK integration |
| [`@grantex/conformance`](https://www.npmjs.com/package/@grantex/conformance) | Conformance test suite |
| [`@grantex/cli`](https://www.npmjs.com/package/@grantex/cli) | CLI tool |

---

## License

Apache-2.0. See [LICENSE](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE).
