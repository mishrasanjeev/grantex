package grantex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
)

// DPDPService handles DPDP (Digital Personal Data Protection Act 2023)
// operations: consent records and withdrawal (s.6(4)), consent notices (s.5),
// the rights to access (s.11) and erasure (s.12), grievance redressal (s.13)
// and compliance exports.
//
// Writes (POST and PATCH) other than RequestErasure are sent exactly once,
// whatever WithMaxRetries says: they are not idempotent, and a replay after a
// timeout or 5xx would duplicate a record, grievance, notice or export, or
// fail with a spurious 409. Erasure is idempotent on the server (a replay
// returns the earlier request), so it and the reads keep the client's retry
// behaviour.
type DPDPService struct {
	http *httpClient
}

// Consent record statuses.
const (
	ConsentStatusActive    = "active"
	ConsentStatusWithdrawn = "withdrawn"
	ConsentStatusErased    = "erased"
	ConsentStatusExpired   = "expired"
)

// Grievance statuses: submitted -> in_review -> resolved | rejected.
const (
	GrievanceStatusSubmitted = "submitted"
	GrievanceStatusInReview  = "in_review"
	GrievanceStatusResolved  = "resolved"
	GrievanceStatusRejected  = "rejected"
)

// Export statuses. GET returns ExportStatusComplete; an expired export
// answers 410 GONE instead.
const (
	ExportStatusComplete = "complete"
	ExportStatusExpired  = "expired"
)

// ExportType names a compliance export. It is an alias of string so existing
// code that sets CreateExportParams.Type from a string keeps compiling.
type ExportType = string

// Compliance export types.
const (
	ExportTypeDPDPAudit          ExportType = "dpdp-audit"
	ExportTypeGDPRArticle15      ExportType = "gdpr-article-15"
	ExportTypeEUAIActConformance ExportType = "eu-ai-act-conformance"
)

// ── Request types ────────────────────────────────────────────────────────────

// CreateConsentRecordParams contains the parameters for creating a consent record.
type CreateConsentRecordParams struct {
	GrantID         string           `json:"grantId"`
	DataPrincipalID string           `json:"dataPrincipalId"`
	Purposes        []ConsentPurpose `json:"purposes"`
	ConsentNoticeID string           `json:"consentNoticeId"`
	// ConsentNoticeVersion binds a notice version; the server uses the latest
	// version when it is empty.
	ConsentNoticeVersion string `json:"consentNoticeVersion,omitempty"`
	ProcessingExpiresAt  string `json:"processingExpiresAt"`
}

// ConsentPurpose describes a data processing purpose for DPDP consent.
type ConsentPurpose struct {
	Code        string `json:"code"`
	Description string `json:"description"`
}

// WithdrawConsentParams contains the parameters for withdrawing consent.
//
// When neither RevokeGrant nor KeepGrant is set, revokeGrant is omitted and
// the server default applies.
type WithdrawConsentParams struct {
	Reason string `json:"reason"`
	// RevokeGrant sends revokeGrant: true.
	RevokeGrant bool `json:"revokeGrant,omitempty"`
	// KeepGrant sends revokeGrant: false. It cannot be combined with RevokeGrant.
	KeepGrant bool `json:"-"`
	// DeleteProcessedData records a deletion request for the Data Fiduciary.
	DeleteProcessedData bool `json:"deleteProcessedData,omitempty"`
}

// MarshalJSON writes revokeGrant: false when KeepGrant is set.
func (p WithdrawConsentParams) MarshalJSON() ([]byte, error) {
	body := map[string]interface{}{"reason": p.Reason}
	if p.RevokeGrant {
		body["revokeGrant"] = true
	} else if p.KeepGrant {
		body["revokeGrant"] = false
	}
	if p.DeleteProcessedData {
		body["deleteProcessedData"] = true
	}
	return json.Marshal(body)
}

// CreateConsentNoticeParams contains the parameters for creating a consent notice.
type CreateConsentNoticeParams struct {
	NoticeID             string            `json:"noticeId"`
	Version              string            `json:"version"`
	Title                string            `json:"title"`
	Content              string            `json:"content"`
	Purposes             []ConsentPurpose  `json:"purposes"`
	Language             string            `json:"language,omitempty"`
	DataFiduciaryContact string            `json:"dataFiduciaryContact,omitempty"`
	GrievanceOfficer     *GrievanceOfficer `json:"grievanceOfficer,omitempty"`
}

// GrievanceOfficer represents the grievance officer contact info in a consent notice.
type GrievanceOfficer struct {
	Name  string `json:"name"`
	Email string `json:"email"`
	Phone string `json:"phone,omitempty"`
}

// FileGrievanceParams contains the parameters for filing a DPDP grievance.
type FileGrievanceParams struct {
	DataPrincipalID string `json:"dataPrincipalId"`
	// Type is free text up to 128 characters, e.g. "consent-violation",
	// "data-breach", "unauthorized-processing".
	Type        string                 `json:"type"`
	Description string                 `json:"description"`
	RecordID    string                 `json:"recordId,omitempty"`
	Evidence    map[string]interface{} `json:"evidence,omitempty"`
	// ResponsePeriodDays is 1..90; the server default is 7 (a product
	// default, not a statutory period).
	ResponsePeriodDays int `json:"responsePeriodDays,omitempty"`
}

// UpdateGrievanceParams moves a grievance to a new status. Resolution is
// required for GrievanceStatusResolved and GrievanceStatusRejected.
type UpdateGrievanceParams struct {
	Status     string `json:"status"`
	Resolution string `json:"resolution,omitempty"`
}

// CreateExportParams contains the parameters for creating a compliance export.
type CreateExportParams struct {
	Type ExportType `json:"type"`
	// DateFrom is an ISO date-time; a bare YYYY-MM-DD means 00:00Z of that day.
	DateFrom string `json:"dateFrom"`
	// DateTo is an ISO date-time; send an end-of-day time to include the whole last day.
	DateTo string `json:"dateTo"`
	// Format is optional; only "json" is produced.
	Format                string `json:"format,omitempty"`
	IncludeActionLog      *bool  `json:"includeActionLog,omitempty"`
	IncludeConsentRecords *bool  `json:"includeConsentRecords,omitempty"`
	DataPrincipalID       string `json:"dataPrincipalId,omitempty"`
}

// PageParams selects a page of a list. Limit is 1..200 (0 means the server
// default, 50); Cursor is the previous page's NextCursor. The consent-record
// lists paginate only when Limit or Cursor is set; with neither the server
// returns the newest 100 records (every match when filtered by principal,
// and every record of the principal on the principal-records route) and a nil
// NextCursor.
type PageParams struct {
	Limit  int
	Cursor string
}

// ListConsentRecordsParams filters and pages ListConsentRecordsPage.
type ListConsentRecordsParams struct {
	DataPrincipalID string
	Limit           int
	Cursor          string
}

// ListGrievancesParams filters and pages ListGrievances.
type ListGrievancesParams struct {
	Status          string
	DataPrincipalID string
	Limit           int
	Cursor          string
}

// ── Response types ───────────────────────────────────────────────────────────

// ConsentProof is the detached EdDSA proof over a consent record, returned
// only by CreateConsentRecord.
type ConsentProof struct {
	Type string  `json:"type"`
	Alg  string  `json:"alg"`
	Kid  *string `json:"kid"`
	// KeyPersistence is "persistent" when the signing key comes from the
	// server's configuration, or "ephemeral" when it was generated in-process,
	// so the proof cannot be verified on another instance or after a restart.
	// Empty when an older server omits it.
	KeyPersistence string `json:"keyPersistence,omitempty"`
	ProofJWT       string `json:"proofJwt"`
	JWKSURI        string `json:"jwksUri"`
	SignedAt       string `json:"signedAt"`
}

// ConsentRecord represents a DPDP consent record.
//
// ConsentProof and ConsentNoticeHash are only returned by CreateConsentRecord;
// create in turn omits Purposes, Scopes, ConsentGivenAt and DataFiduciaryName.
type ConsentRecord struct {
	RecordID          string `json:"recordId"`
	GrantID           string `json:"grantId"`
	DataPrincipalID   string `json:"dataPrincipalId"`
	Status            string `json:"status"`
	ConsentNoticeHash string `json:"consentNoticeHash,omitempty"`
	// ConsentProof is the proof as an untyped map; Proof is the same value typed.
	ConsentProof        map[string]interface{} `json:"consentProof,omitempty"`
	Proof               *ConsentProof          `json:"-"`
	ProcessingExpiresAt string                 `json:"processingExpiresAt,omitempty"`
	RetentionUntil      string                 `json:"retentionUntil,omitempty"`
	DataFiduciaryName   string                 `json:"dataFiduciaryName,omitempty"`
	Purposes            []ConsentPurpose       `json:"purposes,omitempty"`
	Scopes              []string               `json:"scopes,omitempty"`
	ConsentNoticeID     string                 `json:"consentNoticeId,omitempty"`
	// ConsentNoticeVersion is nil on records written before notice versions were tracked.
	ConsentNoticeVersion *string `json:"consentNoticeVersion,omitempty"`
	ConsentGivenAt       string  `json:"consentGivenAt,omitempty"`
	AccessCount          int     `json:"accessCount,omitempty"`
	LastAccessedAt       string  `json:"lastAccessedAt,omitempty"`
	WithdrawnAt          *string `json:"withdrawnAt"`
	WithdrawnReason      *string `json:"withdrawnReason"`
	ErasedAt             *string `json:"erasedAt,omitempty"`
	CreatedAt            string  `json:"createdAt,omitempty"`
}

// UnmarshalJSON decodes a consent record and fills Proof from consentProof.
func (r *ConsentRecord) UnmarshalJSON(data []byte) error {
	type plain ConsentRecord
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	*r = ConsentRecord(p)
	if r.ConsentProof != nil {
		var envelope struct {
			ConsentProof *ConsentProof `json:"consentProof"`
		}
		if err := json.Unmarshal(data, &envelope); err != nil {
			return err
		}
		r.Proof = envelope.ConsentProof
	}
	return nil
}

// ListConsentRecordsResponse is one page of consent records.
type ListConsentRecordsResponse struct {
	Records      []ConsentRecord `json:"records"`
	TotalRecords int             `json:"totalRecords"`
	// NextCursor is nil on the last page.
	NextCursor *string `json:"nextCursor"`
}

type listConsentRecordsResponse = ListConsentRecordsResponse

// WithdrawConsentResponse is the result of withdrawing consent.
type WithdrawConsentResponse struct {
	RecordID     string `json:"recordId"`
	Status       string `json:"status"`
	WithdrawnAt  string `json:"withdrawnAt"`
	GrantRevoked bool   `json:"grantRevoked"`
	// DataDeleted is always false: see DataDeletionRequested.
	DataDeleted           bool `json:"dataDeleted"`
	DataDeletionRequested bool `json:"dataDeletionRequested"`
}

// PrincipalRecordsResponse contains the consent records for a data principal.
type PrincipalRecordsResponse struct {
	DataPrincipalID string          `json:"dataPrincipalId"`
	Records         []ConsentRecord `json:"records"`
	TotalRecords    int             `json:"totalRecords"`
	NextCursor      *string         `json:"nextCursor"`
}

// ErasureRetainedCategory is data an erasure kept, and why. Count is nil for
// uncounted categories.
type ErasureRetainedCategory struct {
	Category string `json:"category"`
	Count    *int   `json:"count,omitempty"`
	Reason   string `json:"reason"`
}

// ErasureResponse is the result of a data erasure request, which completes
// synchronously.
type ErasureResponse struct {
	RequestID              string                    `json:"requestId"`
	DataPrincipalID        string                    `json:"dataPrincipalId"`
	Status                 string                    `json:"status"`
	RecordsErased          int                       `json:"recordsErased"`
	GrantsRevoked          int                       `json:"grantsRevoked"`
	DelegatedGrantsRevoked int                       `json:"delegatedGrantsRevoked"`
	GrievancesRedacted     int                       `json:"grievancesRedacted"`
	ExportsDeleted         int                       `json:"exportsDeleted"`
	Retained               []ErasureRetainedCategory `json:"retained"`
	SubmittedAt            string                    `json:"submittedAt"`
	CompletedAt            string                    `json:"completedAt"`
	// Deprecated: equal to CompletedAt.
	ExpectedCompletionBy string `json:"expectedCompletionBy"`
}

// ConsentNotice is the result of registering a consent notice version.
type ConsentNotice struct {
	ID          string `json:"id"`
	NoticeID    string `json:"noticeId"`
	Version     string `json:"version"`
	Language    string `json:"language"`
	ContentHash string `json:"contentHash"`
	CreatedAt   string `json:"createdAt"`
}

// ConsentNoticeSummary is one notice version in ListConsentNotices.
type ConsentNoticeSummary struct {
	ID          string `json:"id"`
	NoticeID    string `json:"noticeId"`
	Version     string `json:"version"`
	Language    string `json:"language"`
	Title       string `json:"title"`
	ContentHash string `json:"contentHash"`
	CreatedAt   string `json:"createdAt"`
}

// ListConsentNoticesResponse is one page of consent notice versions.
type ListConsentNoticesResponse struct {
	Notices    []ConsentNoticeSummary `json:"notices"`
	NextCursor *string                `json:"nextCursor"`
}

// ConsentNoticeVersion is one version of a consent notice.
type ConsentNoticeVersion struct {
	ID                   string            `json:"id"`
	Version              string            `json:"version"`
	Language             string            `json:"language"`
	Title                string            `json:"title"`
	Content              string            `json:"content"`
	Purposes             []ConsentPurpose  `json:"purposes"`
	DataFiduciaryContact *string           `json:"dataFiduciaryContact"`
	GrievanceOfficer     *GrievanceOfficer `json:"grievanceOfficer"`
	ContentHash          string            `json:"contentHash"`
	CreatedAt            string            `json:"createdAt"`
}

// ConsentNoticeDetail holds every version of a consent notice, newest first.
type ConsentNoticeDetail struct {
	NoticeID string                 `json:"noticeId"`
	Versions []ConsentNoticeVersion `json:"versions"`
}

// Grievance represents a DPDP grievance. List items omit Description and
// Evidence; the file response omits DataPrincipalID.
type Grievance struct {
	GrievanceID          string                 `json:"grievanceId"`
	Status               string                 `json:"status"`
	Type                 string                 `json:"type,omitempty"`
	ReferenceNumber      string                 `json:"referenceNumber,omitempty"`
	DataPrincipalID      string                 `json:"dataPrincipalId,omitempty"`
	RecordID             *string                `json:"recordId"`
	Description          string                 `json:"description,omitempty"`
	Evidence             map[string]interface{} `json:"evidence,omitempty"`
	ExpectedResolutionBy string                 `json:"expectedResolutionBy,omitempty"`
	ResponsePeriodDays   int                    `json:"responsePeriodDays,omitempty"`
	ResolvedAt           *string                `json:"resolvedAt"`
	Resolution           *string                `json:"resolution"`
	CreatedAt            string                 `json:"createdAt,omitempty"`
	UpdatedAt            *string                `json:"updatedAt,omitempty"`
}

// ListGrievancesResponse is one page of grievances.
type ListGrievancesResponse struct {
	Grievances []Grievance `json:"grievances"`
	NextCursor *string     `json:"nextCursor"`
}

// ComplianceExport represents a DPDP compliance export. Status, DateFrom and
// DateTo are only returned by GetExport; CreateExport returns no status.
type ComplianceExport struct {
	ExportID    string                 `json:"exportId"`
	Type        ExportType             `json:"type"`
	Status      string                 `json:"status,omitempty"`
	Format      string                 `json:"format,omitempty"`
	RecordCount int                    `json:"recordCount,omitempty"`
	Data        map[string]interface{} `json:"data,omitempty"`
	DateFrom    string                 `json:"dateFrom,omitempty"`
	DateTo      string                 `json:"dateTo,omitempty"`
	ExpiresAt   string                 `json:"expiresAt,omitempty"`
	CreatedAt   string                 `json:"createdAt,omitempty"`
	// Truncated is true when the audit log hit AuditLogLimit and was cut off.
	Truncated       bool    `json:"truncated,omitempty"`
	AuditLogLimit   int     `json:"auditLogLimit,omitempty"`
	DataPrincipalID *string `json:"dataPrincipalId,omitempty"`
}

// DpdpExport is an alias matching the TypeScript SDK name.
type DpdpExport = ComplianceExport

// ── Helpers ──────────────────────────────────────────────────────────────────

func pageQuery(pairs ...string) string {
	q := url.Values{}
	for i := 0; i+1 < len(pairs); i += 2 {
		if pairs[i+1] != "" {
			q.Set(pairs[i], pairs[i+1])
		}
	}
	if len(q) == 0 {
		return ""
	}
	return "?" + q.Encode()
}

func limitString(limit int) string {
	if limit <= 0 {
		return ""
	}
	return strconv.Itoa(limit)
}

// ── Service methods ──────────────────────────────────────────────────────────

// CreateConsentRecord creates a DPDP consent record linked to a Grantex grant.
// Only this response carries the consent proof and notice hash.
func (s *DPDPService) CreateConsentRecord(ctx context.Context, params CreateConsentRecordParams) (*ConsentRecord, error) {
	return unmarshal[ConsentRecord](s.http.postNoRetry(ctx, "/v1/dpdp/consent-records", params))
}

// GetConsentRecord fetches a single consent record by ID.
func (s *DPDPService) GetConsentRecord(ctx context.Context, recordID string) (*ConsentRecord, error) {
	return unmarshal[ConsentRecord](s.http.get(ctx, fmt.Sprintf("/v1/dpdp/consent-records/%s", url.PathEscape(recordID))))
}

// ListConsentRecords lists the first page of consent records, optionally
// filtered by data principal ID.
//
// Deprecated: it returns only the records and drops totalRecords and the
// next-page cursor. Use ListConsentRecordsPage.
func (s *DPDPService) ListConsentRecords(ctx context.Context, principalID string) ([]ConsentRecord, error) {
	resp, err := s.ListConsentRecordsPage(ctx, ListConsentRecordsParams{DataPrincipalID: principalID})
	if err != nil || resp == nil {
		return nil, err
	}
	return resp.Records, nil
}

// ListConsentRecordsPage lists consent records, newest first, with the total
// count and the cursor for the next page.
func (s *DPDPService) ListConsentRecordsPage(ctx context.Context, params ListConsentRecordsParams) (*ListConsentRecordsResponse, error) {
	path := "/v1/dpdp/consent-records" + pageQuery(
		"dataPrincipalId", params.DataPrincipalID,
		"limit", limitString(params.Limit),
		"cursor", params.Cursor,
	)
	return unmarshal[ListConsentRecordsResponse](s.http.get(ctx, path))
}

// WithdrawConsent withdraws consent for a consent record (DPDP Act s.6(4)).
func (s *DPDPService) WithdrawConsent(ctx context.Context, recordID string, params WithdrawConsentParams) (*WithdrawConsentResponse, error) {
	if params.RevokeGrant && params.KeepGrant {
		return nil, errors.New("grantex: WithdrawConsentParams: RevokeGrant and KeepGrant are mutually exclusive")
	}
	return unmarshal[WithdrawConsentResponse](s.http.postNoRetry(ctx, fmt.Sprintf("/v1/dpdp/consent-records/%s/withdraw", url.PathEscape(recordID)), params))
}

// ListPrincipalRecords lists the first page of a data principal's consent
// records (right to access, DPDP Act s.11). Use ListPrincipalRecordsPage for
// later pages.
func (s *DPDPService) ListPrincipalRecords(ctx context.Context, principalID string) (*PrincipalRecordsResponse, error) {
	return s.ListPrincipalRecordsPage(ctx, principalID, PageParams{})
}

// ListPrincipalRecordsPage lists one page of a data principal's consent records.
func (s *DPDPService) ListPrincipalRecordsPage(ctx context.Context, principalID string, page PageParams) (*PrincipalRecordsResponse, error) {
	path := fmt.Sprintf("/v1/dpdp/data-principals/%s/records", url.PathEscape(principalID)) +
		pageQuery("limit", limitString(page.Limit), "cursor", page.Cursor)
	resp, err := unmarshal[PrincipalRecordsResponse](s.http.get(ctx, path))
	if err != nil || resp == nil {
		return resp, err
	}
	// Older servers omit the per-record dataPrincipalId; it is the top-level one.
	for i := range resp.Records {
		if resp.Records[i].DataPrincipalID == "" {
			resp.Records[i].DataPrincipalID = resp.DataPrincipalID
		}
	}
	return resp, nil
}

// RequestErasure erases a data principal's personal data (right to erasure,
// DPDP Act s.12). The server is idempotent: a repeat returns the earlier
// request, so a transient failure is retried like a read.
func (s *DPDPService) RequestErasure(ctx context.Context, principalID string) (*ErasureResponse, error) {
	return unmarshal[ErasureResponse](s.http.post(ctx, fmt.Sprintf("/v1/dpdp/data-principals/%s/erasure", url.PathEscape(principalID)), nil))
}

// GetErasureRequest fetches an erasure request by ID.
func (s *DPDPService) GetErasureRequest(ctx context.Context, requestID string) (*ErasureResponse, error) {
	return unmarshal[ErasureResponse](s.http.get(ctx, fmt.Sprintf("/v1/dpdp/erasure-requests/%s", url.PathEscape(requestID))))
}

// CreateConsentNotice registers a consent notice version (DPDP Act s.5).
func (s *DPDPService) CreateConsentNotice(ctx context.Context, params CreateConsentNoticeParams) (*ConsentNotice, error) {
	return unmarshal[ConsentNotice](s.http.postNoRetry(ctx, "/v1/dpdp/consent-notices", params))
}

// ListConsentNotices lists consent notice versions, newest first.
func (s *DPDPService) ListConsentNotices(ctx context.Context, page PageParams) (*ListConsentNoticesResponse, error) {
	path := "/v1/dpdp/consent-notices" + pageQuery("limit", limitString(page.Limit), "cursor", page.Cursor)
	return unmarshal[ListConsentNoticesResponse](s.http.get(ctx, path))
}

// GetConsentNotice returns every version of a consent notice, newest first.
func (s *DPDPService) GetConsentNotice(ctx context.Context, noticeID string) (*ConsentNoticeDetail, error) {
	return unmarshal[ConsentNoticeDetail](s.http.get(ctx, fmt.Sprintf("/v1/dpdp/consent-notices/%s", url.PathEscape(noticeID))))
}

// FileGrievance files a grievance (DPDP Act s.13).
func (s *DPDPService) FileGrievance(ctx context.Context, params FileGrievanceParams) (*Grievance, error) {
	return unmarshal[Grievance](s.http.postNoRetry(ctx, "/v1/dpdp/grievances", params))
}

// GetGrievance retrieves a grievance by ID.
func (s *DPDPService) GetGrievance(ctx context.Context, grievanceID string) (*Grievance, error) {
	return unmarshal[Grievance](s.http.get(ctx, fmt.Sprintf("/v1/dpdp/grievances/%s", url.PathEscape(grievanceID))))
}

// ListGrievances lists grievances, newest first. Items omit Description and Evidence.
func (s *DPDPService) ListGrievances(ctx context.Context, params ListGrievancesParams) (*ListGrievancesResponse, error) {
	path := "/v1/dpdp/grievances" + pageQuery(
		"status", params.Status,
		"dataPrincipalId", params.DataPrincipalID,
		"limit", limitString(params.Limit),
		"cursor", params.Cursor,
	)
	return unmarshal[ListGrievancesResponse](s.http.get(ctx, path))
}

// UpdateGrievance moves a grievance: submitted -> in_review -> resolved | rejected.
func (s *DPDPService) UpdateGrievance(ctx context.Context, grievanceID string, params UpdateGrievanceParams) (*Grievance, error) {
	return unmarshal[Grievance](s.http.patchNoRetry(ctx, fmt.Sprintf("/v1/dpdp/grievances/%s", url.PathEscape(grievanceID)), params))
}

// CreateExport generates a compliance export (DPDP audit, GDPR Article 15, EU AI Act).
func (s *DPDPService) CreateExport(ctx context.Context, params CreateExportParams) (*ComplianceExport, error) {
	return unmarshal[ComplianceExport](s.http.postNoRetry(ctx, "/v1/dpdp/exports", params))
}

// GetExport retrieves an export by ID. An expired export fails with a 410
// APIError whose Code is "GONE".
func (s *DPDPService) GetExport(ctx context.Context, exportID string) (*ComplianceExport, error) {
	return unmarshal[ComplianceExport](s.http.get(ctx, fmt.Sprintf("/v1/dpdp/exports/%s", url.PathEscape(exportID))))
}
