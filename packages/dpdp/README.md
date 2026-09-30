# @grantex/dpdp

[![npm version](https://img.shields.io/npm/v/@grantex/dpdp.svg)](https://www.npmjs.com/package/@grantex/dpdp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

**DPDP Act 2023 and EU AI Act evidence helpers for AI agents using the [Grantex](https://grantex.dev) authorization protocol. A technical control mapping, not legal advice or a certification.**

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

India's **Digital Personal Data Protection Act, 2023** (DPDP Act), with the **DPDP Rules 2025**,
and the **EU AI Act** (Regulation (EU) 2024/1689, as amended by Regulation (EU) 2026/1744) set
requirements on how personal data is collected and processed and how AI systems are governed,
including when AI agents act on behalf of people. Most DPDP obligations apply from
13 May 2027; the EU AI Act applies in stages (Art. 50 from 2 August 2026, Annex III high-risk
obligations from 2 December 2027).

`@grantex/dpdp` connects the Grantex delegated authorization protocol to the Grantex DPDP API.
It provides purpose-linked consent records, grievance records, data principal rights requests,
and machine-readable exports that can help a Data Fiduciary or AI system operator evidence some
of its obligations. It does not by itself meet any regulation: Grantex is not a registered
Consent Manager, does not notify the Data Protection Board or data principals, and does not
perform conformity assessments. See the
[DPDP mapping](https://docs.grantex.dev/compliance/dpdp-act-2023) and the
[EU AI Act mapping](https://docs.grantex.dev/compliance/eu-ai-act).

### Key capabilities

| Capability | Description |
|---|---|
| **Consent Records** | Consent records linked to Grantex grants; the server signs a consent proof (JWS, EdDSA) over each |
| **Purpose Checks** | Client-side checks that grant scopes cover declared processing purposes (the server does not enforce purposes) |
| **Consent Withdrawal** | Withdrawal with optional grant revocation and a data-deletion request to your application by webhook (Grantex deletes none of your data) |
| **Grievance Records** | Record grievances and their due dates (DPDP Act s.13) |
| **Data Principal Rights** | Access (s.11) and erasure (s.12) requests; the DPDP Act has no portability right |
| **DPDP Audit Export** | Structured export of consent records, audit entries and grievances (not a format prescribed by the Board) |
| **GDPR Article 15 Export** | Machine-readable input to a data subject access response, covering what Grantex holds |
| **EU AI Act Export** | Records mapped to EU AI Act articles; not a conformity assessment |
| **Region Configuration** | India (IN) and EU region-specific settings |

---

## Regulatory Coverage

### DPDP Act 2023 Mapping

| DPDP Section | Requirement | @grantex/dpdp Feature |
|---|---|---|
| Section 4 | Processing for lawful purpose | `enforcePurpose()` — client-side scope-to-purpose check |
| Section 5 (Rules r.3) | Notice to data principal | `createConsentNotice()` — versioned, hashed notices |
| Section 6, 6(10) | Consent and proof of consent | `createConsentRecord()` — the server signs a consent proof |
| Section 6(4), 6(6) | Withdrawal; cease processing | `withdrawConsent()` — optional grant revocation; stopping processing in your systems is yours |
| Section 8(7) | Erasure when consent is withdrawn or the purpose is served | `retentionUntil` is recorded only; Grantex deletes nothing when it passes |
| Section 11 | Right to access | `getDataPrincipalRecords()` — records Grantex holds |
| Section 12 | Right to correction & erasure | `requestDataErasure()` — erasure request |
| Section 13 (Rules r.14(3)) | Grievance redressal | `fileGrievance()` — records the grievance and a due date; the fiduciary publishes a period of up to 90 days |
| Section 8(5); DPDP Rules 2025 r.6(1)(e), r.8(3) | Security safeguards; one-year log retention | `requestDpdpExport()` — audit trail export |

### EU AI Act Mapping

| EU AI Act Article | Requirement | @grantex/dpdp Feature |
|---|---|---|
| Article 9 | Risk management (high-risk providers) | Not provided; grants and scopes are controls you can cite |
| Article 10 | Data governance | Not provided |
| Article 11 | Technical documentation | Not provided; exports can be annexed as records |
| Article 12 | Record-keeping | Audit trail of authorisation events, not the AI system's own logs |
| Article 13 | Transparency to deployers | Not provided |
| Article 14 | Human oversight | Consent method and grant records |
| Article 15 | Accuracy & security | Signed consent proofs and SHA-256 notice hashes support integrity |
| Article 26 | Deployer obligations | Exports as records for deployers |
| Article 50 | Transparency obligations for certain AI systems (applies from 2 August 2026) | Not recorded; GPAI model obligations are Arts. 53-55 |

### GDPR Mapping

| GDPR Article | Requirement | @grantex/dpdp Feature |
|---|---|---|
| Article 6 | Lawful basis | `legalBasis` on the local purpose model (not stored by the server) |
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
import { createConsentNotice, createConsentRecord } from '@grantex/dpdp';

// Register the notice version the data principal is shown (once per version).
await createConsentNotice({
  noticeId: 'privacy-notice',
  version: '1.0',
  language: 'en',
  title: 'Data Processing Consent Notice',
  content: 'We will process your email data...',
  purposes: [{ code: 'email-access', description: 'Read and send emails on behalf of the user' }],
  dataFiduciaryContact: 'privacy@merchant.example',
  grievanceOfficer: { name: 'Grievance Officer', email: 'grievance@merchant.example', phone: '+91-00000-00000' },
  apiKey: process.env.GRANTEX_API_KEY!,
  baseUrl: 'https://api.grantex.dev',
});

const record = await createConsentRecord({
  grantId: 'grnt_abc123',
  dataPrincipalId: 'user_456',
  purposes: [{ code: 'email-access', description: 'Read and send emails on behalf of the user' }],
  consentNoticeId: 'privacy-notice',
  consentNoticeVersion: '1.0',            // optional; the latest version when omitted
  processingExpiresAt: new Date('2027-01-01'),
  proofIpAddress: '192.0.2.1',            // local-only: returned hashed in localEvidence, never sent
  apiKey: process.env.GRANTEX_API_KEY!,
  baseUrl: 'https://auth.grantex.dev',
});

console.log(record.recordId);               // 'crec_...'
console.log(record.consentNoticeHash);      // SHA-256 of the notice version, computed by the server
console.log(record.consentProof.proofJwt);  // JWS (EdDSA) signed by the server; verify with consentProof.jwksUri
console.log(record.localEvidence?.ipAddressHash); // SHA-256 of the IP, kept client-side
```

Purposes may also be given in the local `ConsentPurpose` model (for example from
`PurposeRegistry.toConsentPurpose()`); they are sent as `{ code: purposeId, description }`.

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
  'crec_001',
  'User no longer wants email processing',
  {
    revokeGrant: true,           // Also revoke the Grantex grant token
    deleteProcessedData: true,   // Request data deletion
    apiKey: process.env.GRANTEX_API_KEY!,
    baseUrl: 'https://api.grantex.dev',
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
    recordId: 'crec_001',                 // optional
    type: 'unauthorized-processing',      // any string; see GRIEVANCE_TYPES
    description: 'Agent accessed calendar data without consent',
    evidence: { auditEntries: ['audit_entry_789'] }, // optional JSON object, up to 16 KiB
    responsePeriodDays: 7,                // optional, 1..90; server default 7
  },
  process.env.GRANTEX_API_KEY!,
  'https://api.grantex.dev',
);

console.log(grievance.referenceNumber);       // 'GRV-2026-...', assigned by the server
console.log(grievance.expectedResolutionBy);  // Date: now + responsePeriodDays
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
    dateFrom: new Date('2026-01-01T00:00:00Z'),
    dateTo: new Date('2026-03-31T23:59:59.999Z'), // an instant: include the whole last day
    format: 'json',               // optional; JSON is the only format
    includeActionLog: true,       // optional; server default true
    includeConsentRecords: true,  // optional; server default true
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

// EU AI Act export (evidence for your own assessment)
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

console.log(euAiAct.data);      // The report, inline (JSON)
console.log(euAiAct.expiresAt); // After this, getExportStatus() throws ExportExpiredError (410)
```

---

## API Reference

### Consent Records

#### `createConsentRecord(options: CreateConsentRecordOptions): Promise<CreatedConsentRecord>`

Create a DPDP consent record linked to a Grantex grant (`POST /v1/dpdp/consent-records`).

- Sends only `grantId`, `dataPrincipalId`, `purposes` (as `{ code, description }`, 1 to 50),
  `consentNoticeId`, `consentNoticeVersion` (optional) and `processingExpiresAt` (must be in the future)
- Returns the server's `consentNoticeHash` and `consentProof`
  (`{ type: 'JWS-EdDSA', alg, kid, proofJwt, jwksUri, signedAt }`); `createdAt`, not `consentGivenAt`
- Local-only options — `proofIpAddress` (hashed with SHA-256), `proofUserAgent`, `proofSessionId`,
  `consentNoticeContent` (hashed) and `signingKey` (your Ed25519 signature over a canonical payload) —
  are never sent; they are returned in `localEvidence`
- `dataFiduciaryId`, `dataFiduciaryName`, `scopes`, `dataPrincipalDID`, `consentMethod` and
  `retentionUntil` are deprecated and not sent (the server takes scopes from the grant and computes
  `retentionUntil`)
- Errors: `INVALID_GRANT`, `PRINCIPAL_MISMATCH`, `INVALID_NOTICE`, `BAD_REQUEST` (400);
  `CONSENT_PROOF_UNAVAILABLE` (503)

#### `getConsentRecord(recordId: string, apiKey: string, baseUrl: string): Promise<DPDPConsentRecord>`

Fetch a single consent record by ID. Reads carry no `consentProof` or `consentNoticeHash`.

#### `listConsentRecordsPage(options: { dataPrincipalId?, limit?, cursor? }, apiKey, baseUrl): Promise<ConsentRecordPage>`

List consent records, newest first: `{ records, totalRecords, nextCursor }`. `limit` is 1..200
(default 50); pass `nextCursor` back as `cursor` for the next page. Without `limit` or `cursor`
the server does not paginate: it returns the newest 100 records, or every record of
`dataPrincipalId` when given, with `nextCursor: null`.

#### `listConsentRecords(principalId: string, apiKey: string, baseUrl: string, page?: { limit?, cursor? }): Promise<DPDPConsentRecord[]>`

One page of a data principal's consent records, as an array.

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
| `getStats()` | Get registry statistics (active, withdrawn, expired and erased counts) |

---

### Consent Notices

#### `createConsentNotice(options: CreateConsentNoticeOptions): Promise<ConsentNoticeCreated>`

Register one version of a consent notice (`POST /v1/dpdp/consent-notices`). Sends `noticeId`,
`version`, `language` (default `'en'`), `title`, `content`, `purposes` (as `{ code, description }`),
`dataFiduciaryContact` and `grievanceOfficer` (`{ name, email, phone? }`). The server computes the
content hash and returns `{ id, noticeId, version, language, contentHash, createdAt }`. A repeated
`(noticeId, version)` fails with 409 `CONFLICT`.

#### `listConsentNotices(options: { limit?, cursor? }, apiKey, baseUrl): Promise<ConsentNoticePage>`

List notice versions, newest first: `{ notices, nextCursor }`.

#### `getConsentNotice(noticeId: string, apiKey: string, baseUrl: string): Promise<ConsentNoticeVersions>`

Every version of one notice, newest first, with content, purposes, contact and grievance officer.

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
| `deleteProcessedData` | `boolean` | Request deletion of data processed under this consent (returned as `dataDeletionRequested`; the data fiduciary carries it out, so `dataDeleted` is always `false`) |
| `apiKey` | `string` | Grantex API key |
| `baseUrl` | `string` | Grantex auth service base URL |

Fails with `WithdrawalError` whose `code` is `NOT_FOUND` (404), `ALREADY_WITHDRAWN`,
`CONSENT_ERASED` or `CONSENT_EXPIRED` (409).

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
| `toConsentPurpose(purposeId)` | Convert to the local `ConsentPurpose` model |
| `toWirePurpose(purposeId)` | Convert to the wire shape `{ code, description }` the server stores |

---

### Purpose Enforcement

#### `enforcePurpose(grantScopes: string[], purposeId: string, purposeRegistry: PurposeRegistry): void`

Check that a grant token's scopes satisfy a declared processing purpose.
Throws `PurposeViolationError` if scopes are insufficient.

#### `checkPurposeCompliance(record: DPDPConsentRecord): string[]`

Validate that a consent record is active and has proper purpose definitions. Accepts records
decoded from the server (purposes `{ code, description }`) and local records using the
`ConsentPurpose` model. Returns an array of error strings (empty if compliant).

#### `toWirePurpose(purpose: PurposeInput): WirePurpose`

Map a purpose to the wire shape `{ code, description }` (`purposeId` becomes `code`).

---

### Data Principal Rights

#### `getDataPrincipalRecords(principalId: string, apiKey: string, baseUrl: string, page?: { limit?, cursor? }): Promise<DataPrincipalRecords>`

Fetch a page of the consent records belonging to a data principal (DPDP Section 11):
`{ dataPrincipalId, records, totalRecords, nextCursor }` (`totalCount` is a deprecated alias of
`totalRecords`).

#### `requestDataErasure(principalId: string, apiKey: string, baseUrl: string): Promise<ErasureResult>`

Erase a data principal's data held by Grantex (DPDP Section 12). Sends no body. Completes
synchronously and is idempotent: `httpStatus` 201 (`created: true`) when something was erased now,
200 with the earlier request when nothing was left. Returns `requestId`, `status: 'completed'`,
`recordsErased`, `grantsRevoked`, `delegatedGrantsRevoked`, `grievancesRedacted`, `exportsDeleted`,
`retained` (what was kept, and why), `submittedAt` and `completedAt`. 404 `NOT_FOUND` when the
principal has no records. Because a replay is safe, a network error or a 429/502/503/504 is retried
with backoff (up to 3 attempts in total); the other DPDP writes are sent once.

#### `getErasureRequest(requestId: string, apiKey: string, baseUrl: string): Promise<ErasureRequest>`

Fetch a completed erasure request.

---

### Grievances

#### `fileGrievance(params: FileGrievanceParams, apiKey: string, baseUrl: string): Promise<GrievanceReceipt>`

File a grievance (DPDP Section 13). `recordId`, `evidence` (any JSON object up to 16 KiB) and
`responsePeriodDays` (integer 1..90; server default 7) are optional. `type` is any string;
`GRIEVANCE_TYPES` lists suggested values (`'consent-violation'`, `'data-breach'`,
`'unauthorized-processing'`, `'withdrawal-refused'`, `'other'`). Returns
`{ grievanceId, referenceNumber, type, status: 'submitted', responsePeriodDays, expectedResolutionBy, createdAt }`.

#### `getGrievanceStatus(grievanceId: string, apiKey: string, baseUrl: string): Promise<Grievance>`

Get a grievance, with description, evidence, status and resolution.

#### `listGrievances(options: { status?, dataPrincipalId?, limit?, cursor? }, apiKey, baseUrl): Promise<GrievancePage>`

List grievances, newest first: `{ grievances, nextCursor }` (list items have no description or evidence).

#### `updateGrievance(grievanceId: string, params: { status, resolution? }, apiKey, baseUrl): Promise<Grievance>`

Move a grievance along: `submitted` → `in_review` → `resolved` | `rejected`. `resolution` is
required for `resolved` and `rejected`. Other transitions fail with 409 `INVALID_TRANSITION`.

#### `generateReferenceNumber(): string`

Deprecated: the server assigns each grievance its reference number; use the one `fileGrievance()`
returns. Generates a local reference in format `GRV-YYYY-XXXXXXXXXXXXXXXX`, where the suffix is 16
lowercase hex characters drawn from a cryptographically strong source (64 bits of entropy).

#### `calculateExpectedResolution(fromDate?: Date, days?: number): Date`

Calculate an expected resolution date: `days` calendar days (default 7) after the given date.
Seven days is a product default, not a statutory period: under DPDP Rules 2025 r.14(3) the
fiduciary publishes its own response period, of at most 90 days.

---

### Compliance Exports

#### `requestDpdpExport(params, apiKey, baseUrl): Promise<ComplianceExportResult>`

Request a DPDP audit export containing consent records, action logs, and summary.

#### `requestGdprExport(params, apiKey, baseUrl): Promise<ComplianceExportResult>`

Request a GDPR Article 15 data subject access request export.

#### `requestEuAiActExport(params, apiKey, baseUrl): Promise<ComplianceExportResult>`

Request an EU AI Act export (`eu-ai-act-conformance`) mapped to the defined articles. It is evidence for your own assessment, not a conformity assessment.

#### `getExportStatus(exportId, apiKey, baseUrl): Promise<ComplianceExportResult>`

Get a previously requested export with its data (`status: 'complete'`, `dateFrom`, `dateTo`).
Throws `ExportExpiredError` (410 `GONE`) once the export has expired and its data was purged.

Export requests send only the fields you give: `format` is `'json'` (the only format produced),
and `includeActionLog` / `includeConsentRecords` default to `true` on the server. Results carry the
data inline (`data`), with `recordCount`, `truncated`, `auditLogLimit`, `expiresAt` and `createdAt`;
there is no download URL.

#### `EU_AI_ACT_ARTICLES`

Constant array of EU AI Act articles the export is mapped to:

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
| 50 | Transparency Obligations for Providers and Deployers of Certain AI Systems |

The Article 50 label in this constant is inaccurate: Art. 50 sets transparency obligations for
certain AI systems (disclosure of AI interaction, marking of generated content), while
general-purpose AI model obligations are in Arts. 53-55.

---

### Regions

#### `REGION_IN: RegionConfig`

India region configuration — DPDP Act settings, 11 supported languages. `dataResidencyRequired`
is `false` (DPDP Act s.16 permits transfer except to countries the Central Government restricts);
`grievanceResolutionDays` is 90, the longest response period DPDP Rules 2025 r.14(3) allows.

#### `REGION_EU: RegionConfig`

European Union region configuration — GDPR + EU AI Act settings, 24 supported languages. The
age of digital consent is 13 to 16 depending on the member state (GDPR Art. 8): `consentMinAge`
is 16 and `consentMinAgeRange` is `{ min: 13, max: 16 }`. `dataResidencyRequired` is `false`:
GDPR Chapter V governs transfers out of the EU/EEA rather than requiring storage in the EU.

#### `REGIONS: Record<string, RegionConfig>`

All supported regions keyed by region code.

#### `getRegion(code: string): RegionConfig | undefined`

Get region config by region code (case-insensitive).

---

### Errors

All errors extend `DpdpError` and include a `code` string, an optional `statusCode` and, for
errors from the server, the `requestId` from the error body. For server errors `code` is the
server's code (for example `ALREADY_WITHDRAWN`, `CONFLICT`, `GONE`); the codes below apply when the
server sent none and to client-side validation.

| Error Class | Code | Description |
|---|---|---|
| `DpdpError` | (varies) | Base error class |
| `ConsentRequiredError` | `CONSENT_REQUIRED` | No consent record exists for the operation |
| `PurposeViolationError` | `PURPOSE_VIOLATION` | Grant scopes do not satisfy the required purpose |
| `WithdrawalError` | `WITHDRAWAL_ERROR` | Consent withdrawal failed |
| `GrievanceError` | `GRIEVANCE_ERROR` | Grievance filing or retrieval failed |
| `ExportError` | `EXPORT_ERROR` | Compliance export failed |
| `ExportExpiredError` | `GONE` | The export expired and its data was purged (410); extends `ExportError` |

`PurposeViolationError` additionally exposes a `missingScopes: string[]` property.

---

## Type Definitions

### DPDPConsentRecord

As `getConsentRecord()` and the list routes return it. Fields the server sends as `null` are omitted.

```typescript
interface DPDPConsentRecord {
  recordId: string;
  grantId: string;
  dataPrincipalId: string;
  dataFiduciaryName?: string;
  purposes: WirePurpose[];              // { code, description }
  scopes: string[];
  consentNoticeId: string;
  consentNoticeVersion?: string;
  status: 'active' | 'withdrawn' | 'expired' | 'erased';
  consentGivenAt: Date;
  processingExpiresAt: Date;
  retentionUntil: Date;
  accessCount: number;
  lastAccessedAt?: Date;
  withdrawnAt?: Date;
  withdrawnReason?: string;
  erasedAt?: Date;
  createdAt?: Date;
}
```

### ConsentPurpose

The local purpose model. Only `purposeId` (as `code`) and `description` are sent; the other
fields are local-only.

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

Returned by `createConsentRecord()` only.

```typescript
interface ConsentProof {
  type: 'JWS-EdDSA';
  alg: string;                          // 'EdDSA'
  kid: string | null;
  keyPersistence?: 'persistent' | 'ephemeral'; // 'ephemeral': verifiable only on the signing instance until it restarts
  proofJwt: string;                     // compact JWS signed by the server
  jwksUri: string;                      // where to fetch the verification key
  signedAt: Date;
}
```

### Grievance

```typescript
interface Grievance {
  grievanceId: string;
  dataPrincipalId: string;
  recordId?: string;
  type: string;                         // e.g. 'unauthorized-processing'
  description: string;
  evidence?: Record<string, unknown>;
  status: 'submitted' | 'in_review' | 'resolved' | 'rejected';
  referenceNumber: string;              // GRV-YYYY-..., assigned by the server
  expectedResolutionBy: Date;           // createdAt + responsePeriodDays
  responsePeriodDays?: number;
  resolvedAt?: Date;
  resolution?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
```

### ComplianceExportRequest

```typescript
interface ComplianceExportRequest {
  type: 'dpdp-audit' | 'gdpr-article-15' | 'eu-ai-act-conformance';
  dateFrom: Date;
  dateTo: Date;
  format?: 'json';                      // the only format produced
  includeActionLog?: boolean;           // server default true
  includeConsentRecords?: boolean;      // server default true
  dataPrincipalId?: string;
}
```

### ComplianceExportResult

```typescript
interface ComplianceExportResult {
  exportId: string;
  type: 'dpdp-audit' | 'gdpr-article-15' | 'eu-ai-act-conformance';
  format: 'json';
  status?: 'complete' | 'expired';      // getExportStatus() only
  dateFrom?: Date;                      // getExportStatus() only
  dateTo?: Date;                        // getExportStatus() only
  recordCount: number;
  truncated: boolean;
  auditLogLimit?: number;
  dataPrincipalId?: string;
  data: unknown;                        // the export, inline
  expiresAt: Date;
  createdAt: Date;
}
```

### RegionConfig

```typescript
interface RegionConfig {
  regionCode: string;
  regionName: string;
  dataResidencyRequired: boolean;
  consentMinAge: number;
  consentMinAgeRange?: { min: number; max: number };
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

The auth service signs a consent proof for every record it creates: a compact JWS (EdDSA) returned
as `consentProof.proofJwt`, verifiable with the key published at `consentProof.jwksUri`. If you
also pass a `signingKey`, the library signs a canonical payload (`grantId`, `dataPrincipalId`,
purpose codes, notice id and version, `processingExpiresAt`, and any `dataFiduciaryId`, `scopes`
and notice hash you supplied) with your Ed25519 key and returns it in `localEvidence`; it is not sent.

### PII Protection

`proofIpAddress`, `proofUserAgent` and `proofSessionId` are local-only: they are never sent to the
server. The IP address is hashed with **SHA-256** and only the hash is returned (in
`localEvidence.ipAddressHash`); the raw address is not kept.

### Consent Notice Hashing

The server hashes each notice version's content with **SHA-256** and stores the hash of the
version consented to with the consent record (`consentNoticeHash`).
This ensures that any modification to the notice text after consent was given is detectable.

### Immutability

The in-memory `ConsentRegistry` freezes the records it holds and rejects duplicate
registrations. On the server, withdrawal, expiry and erasure update the record's status and
timestamps in place; the history of those changes is kept in the developer's hash-chained audit
log, which Grantex never rewrites.

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

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
