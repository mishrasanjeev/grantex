package grantex

import (
	"context"
	"fmt"
	"net/url"
)

// DPDPService handles DPDP (Digital Personal Data Protection Act 2023) operations.
type DPDPService struct {
	http *httpClient
}

// ── Request types ────────────────────────────────────────────────────────────

// CreateConsentRecordParams contains the parameters for creating a consent record.
type CreateConsentRecordParams struct {
	GrantID             string                `json:"grantId"`
	DataPrincipalID     string                `json:"dataPrincipalId"`
	Purposes            []ConsentPurpose      `json:"purposes"`
	ConsentNoticeID     string                `json:"consentNoticeId"`
	ProcessingExpiresAt string                `json:"processingExpiresAt"`
}

// ConsentPurpose describes a data processing purpose for DPDP consent.
type ConsentPurpose struct {
	Code        string `json:"code"`
	Description string `json:"description"`
}

// WithdrawConsentParams contains the parameters for withdrawing consent.
type WithdrawConsentParams struct {
	Reason               string `json:"reason"`
	RevokeGrant          bool   `json:"revokeGrant,omitempty"`
	DeleteProcessedData  bool   `json:"deleteProcessedData,omitempty"`
}

// CreateConsentNoticeParams contains the parameters for creating a consent notice.
type CreateConsentNoticeParams struct {
	NoticeID              string                 `json:"noticeId"`
	Version               string                 `json:"version"`
	Title                 string                 `json:"title"`
	Content               string                 `json:"content"`
	Purposes              []ConsentPurpose       `json:"purposes"`
	Language              string                 `json:"language,omitempty"`
	DataFiduciaryContact  string                 `json:"dataFiduciaryContact,omitempty"`
	GrievanceOfficer      *GrievanceOfficer      `json:"grievanceOfficer,omitempty"`
}

// GrievanceOfficer represents the grievance officer contact info in a consent notice.
type GrievanceOfficer struct {
	Name  string `json:"name"`
	Email string `json:"email"`
	Phone string `json:"phone,omitempty"`
}

// FileGrievanceParams contains the parameters for filing a DPDP grievance.
type FileGrievanceParams struct {
	DataPrincipalID string                 `json:"dataPrincipalId"`
	Type            string                 `json:"type"`
	Description     string                 `json:"description"`
	RecordID        string                 `json:"recordId,omitempty"`
	Evidence        map[string]interface{} `json:"evidence,omitempty"`
}

// CreateExportParams contains the parameters for creating a compliance export.
type CreateExportParams struct {
	Type                  string `json:"type"`
	DateFrom              string `json:"dateFrom"`
	DateTo                string `json:"dateTo"`
	Format                string `json:"format,omitempty"`
	IncludeActionLog      *bool  `json:"includeActionLog,omitempty"`
	IncludeConsentRecords *bool  `json:"includeConsentRecords,omitempty"`
	DataPrincipalID       string `json:"dataPrincipalId,omitempty"`
}

// ── Response types ───────────────────────────────────────────────────────────

// ConsentRecord represents a DPDP consent record.
type ConsentRecord struct {
	RecordID            string                 `json:"recordId"`
	GrantID             string                 `json:"grantId"`
	DataPrincipalID     string                 `json:"dataPrincipalId"`
	Status              string                 `json:"status"`
	ConsentNoticeHash   string                 `json:"consentNoticeHash,omitempty"`
	ConsentProof        map[string]interface{} `json:"consentProof,omitempty"`
	ProcessingExpiresAt string                 `json:"processingExpiresAt,omitempty"`
	RetentionUntil      string                 `json:"retentionUntil,omitempty"`
	DataFiduciaryName   string                 `json:"dataFiduciaryName,omitempty"`
	Purposes            []ConsentPurpose       `json:"purposes,omitempty"`
	Scopes              []string               `json:"scopes,omitempty"`
	ConsentNoticeID     string                 `json:"consentNoticeId,omitempty"`
	ConsentGivenAt      string                 `json:"consentGivenAt,omitempty"`
	AccessCount         int                    `json:"accessCount,omitempty"`
	LastAccessedAt      string                 `json:"lastAccessedAt,omitempty"`
	WithdrawnAt         *string                `json:"withdrawnAt"`
	WithdrawnReason     *string                `json:"withdrawnReason"`
	CreatedAt           string                 `json:"createdAt,omitempty"`
}

type listConsentRecordsResponse struct {
	Records      []ConsentRecord `json:"records"`
	TotalRecords int             `json:"totalRecords"`
}

// WithdrawConsentResponse is the result of withdrawing consent.
type WithdrawConsentResponse struct {
	RecordID     string `json:"recordId"`
	Status       string `json:"status"`
	WithdrawnAt  string `json:"withdrawnAt"`
	GrantRevoked bool   `json:"grantRevoked"`
	DataDeleted  bool   `json:"dataDeleted"`
}

// PrincipalRecordsResponse contains the consent records for a data principal.
type PrincipalRecordsResponse struct {
	DataPrincipalID string          `json:"dataPrincipalId"`
	Records         []ConsentRecord `json:"records"`
	TotalRecords    int             `json:"totalRecords"`
}

// ErasureResponse is the result of a data erasure request.
type ErasureResponse struct {
	RequestID            string `json:"requestId"`
	DataPrincipalID      string `json:"dataPrincipalId"`
	Status               string `json:"status"`
	RecordsErased        int    `json:"recordsErased"`
	GrantsRevoked        int    `json:"grantsRevoked"`
	SubmittedAt          string `json:"submittedAt"`
	ExpectedCompletionBy string `json:"expectedCompletionBy"`
}

// ConsentNotice represents a registered consent notice version.
type ConsentNotice struct {
	ID          string `json:"id"`
	NoticeID    string `json:"noticeId"`
	Version     string `json:"version"`
	Language    string `json:"language"`
	ContentHash string `json:"contentHash"`
	CreatedAt   string `json:"createdAt"`
}

// Grievance represents a DPDP grievance.
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
	ResolvedAt           *string                `json:"resolvedAt"`
	Resolution           *string                `json:"resolution"`
	CreatedAt            string                 `json:"createdAt,omitempty"`
}

// ComplianceExport represents a DPDP compliance export.
type ComplianceExport struct {
	ExportID    string                 `json:"exportId"`
	Type        string                 `json:"type"`
	Status      string                 `json:"status,omitempty"`
	Format      string                 `json:"format,omitempty"`
	RecordCount int                    `json:"recordCount,omitempty"`
	Data        map[string]interface{} `json:"data,omitempty"`
	DateFrom    string                 `json:"dateFrom,omitempty"`
	DateTo      string                 `json:"dateTo,omitempty"`
	ExpiresAt   string                 `json:"expiresAt,omitempty"`
	CreatedAt   string                 `json:"createdAt,omitempty"`
}

// ── Service methods ──────────────────────────────────────────────────────────

// CreateConsentRecord creates a DPDP consent record linked to a Grantex grant.
func (s *DPDPService) CreateConsentRecord(ctx context.Context, params CreateConsentRecordParams) (*ConsentRecord, error) {
	return unmarshal[ConsentRecord](s.http.post(ctx, "/v1/dpdp/consent-records", params))
}

// GetConsentRecord fetches a single consent record by ID.
func (s *DPDPService) GetConsentRecord(ctx context.Context, recordID string) (*ConsentRecord, error) {
	return unmarshal[ConsentRecord](s.http.get(ctx, fmt.Sprintf("/v1/dpdp/consent-records/%s", recordID)))
}

// ListConsentRecords lists consent records, optionally filtered by data principal ID.
func (s *DPDPService) ListConsentRecords(ctx context.Context, principalID string) ([]ConsentRecord, error) {
	path := "/v1/dpdp/consent-records"
	if principalID != "" {
		q := url.Values{}
		q.Set("dataPrincipalId", principalID)
		path += "?" + q.Encode()
	}
	resp, err := unmarshal[listConsentRecordsResponse](s.http.get(ctx, path))
	if err != nil {
		return nil, err
	}
	return resp.Records, nil
}

// WithdrawConsent withdraws consent for a consent record.
func (s *DPDPService) WithdrawConsent(ctx context.Context, recordID string, params WithdrawConsentParams) (*WithdrawConsentResponse, error) {
	return unmarshal[WithdrawConsentResponse](s.http.post(ctx, fmt.Sprintf("/v1/dpdp/consent-records/%s/withdraw", recordID), params))
}

// ListPrincipalRecords lists all consent records for a data principal (right to access).
func (s *DPDPService) ListPrincipalRecords(ctx context.Context, principalID string) (*PrincipalRecordsResponse, error) {
	return unmarshal[PrincipalRecordsResponse](s.http.get(ctx, fmt.Sprintf("/v1/dpdp/data-principals/%s/records", principalID)))
}

// RequestErasure submits a data erasure request for a data principal.
func (s *DPDPService) RequestErasure(ctx context.Context, principalID string) (*ErasureResponse, error) {
	return unmarshal[ErasureResponse](s.http.post(ctx, fmt.Sprintf("/v1/dpdp/data-principals/%s/erasure", principalID), map[string]string{
		"dataPrincipalId": principalID,
	}))
}

// CreateConsentNotice registers a consent notice version.
func (s *DPDPService) CreateConsentNotice(ctx context.Context, params CreateConsentNoticeParams) (*ConsentNotice, error) {
	return unmarshal[ConsentNotice](s.http.post(ctx, "/v1/dpdp/consent-notices", params))
}

// FileGrievance files a grievance under DPDP section 13(6).
func (s *DPDPService) FileGrievance(ctx context.Context, params FileGrievanceParams) (*Grievance, error) {
	return unmarshal[Grievance](s.http.post(ctx, "/v1/dpdp/grievances", params))
}

// GetGrievance retrieves a grievance by ID.
func (s *DPDPService) GetGrievance(ctx context.Context, grievanceID string) (*Grievance, error) {
	return unmarshal[Grievance](s.http.get(ctx, fmt.Sprintf("/v1/dpdp/grievances/%s", grievanceID)))
}

// CreateExport generates a compliance export (DPDP audit, GDPR Article 15, EU AI Act).
func (s *DPDPService) CreateExport(ctx context.Context, params CreateExportParams) (*ComplianceExport, error) {
	return unmarshal[ComplianceExport](s.http.post(ctx, "/v1/dpdp/exports", params))
}

// GetExport retrieves an export by ID.
func (s *DPDPService) GetExport(ctx context.Context, exportID string) (*ComplianceExport, error) {
	return unmarshal[ComplianceExport](s.http.get(ctx, fmt.Sprintf("/v1/dpdp/exports/%s", exportID)))
}
