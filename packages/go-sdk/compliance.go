package grantex

import "context"

// ComplianceService handles compliance reporting and evidence exports.
type ComplianceService struct {
	http *httpClient
}

// GetSummary retrieves a compliance summary.
func (s *ComplianceService) GetSummary(ctx context.Context, params *ComplianceSummaryParams) (*ComplianceSummary, error) {
	path := "/v1/compliance/summary"
	if params != nil {
		q := make(map[string]string)
		if params.Since != "" {
			q["since"] = params.Since
		}
		if params.Until != "" {
			q["until"] = params.Until
		}
		path += buildQueryString(q)
	}
	return unmarshal[ComplianceSummary](s.http.get(ctx, path))
}

// ExportGrants exports grants data for compliance.
func (s *ComplianceService) ExportGrants(ctx context.Context, params *ComplianceExportGrantsParams) (*ComplianceGrantsExport, error) {
	path := "/v1/compliance/export/grants"
	if params != nil {
		q := make(map[string]string)
		if params.Since != "" {
			q["since"] = params.Since
		}
		if params.Until != "" {
			q["until"] = params.Until
		}
		if params.Status != "" {
			q["status"] = params.Status
		}
		path += buildQueryString(q)
	}
	return unmarshal[ComplianceGrantsExport](s.http.get(ctx, path))
}

// ExportAudit exports audit data for compliance.
func (s *ComplianceService) ExportAudit(ctx context.Context, params *ComplianceExportAuditParams) (*ComplianceAuditExport, error) {
	path := "/v1/compliance/export/audit"
	if params != nil {
		q := make(map[string]string)
		if params.Since != "" {
			q["since"] = params.Since
		}
		if params.Until != "" {
			q["until"] = params.Until
		}
		if params.AgentID != "" {
			q["agentId"] = params.AgentID
		}
		if params.Status != "" {
			q["status"] = params.Status
		}
		path += buildQueryString(q)
	}
	return unmarshal[ComplianceAuditExport](s.http.get(ctx, path))
}

// EvidencePack generates a compliance evidence package.
func (s *ComplianceService) EvidencePack(ctx context.Context, params *EvidencePackParams) (*EvidencePack, error) {
	path := "/v1/compliance/evidence-pack"
	if params != nil {
		q := make(map[string]string)
		if params.Since != "" {
			q["since"] = params.Since
		}
		if params.Until != "" {
			q["until"] = params.Until
		}
		if params.Framework != "" {
			q["framework"] = params.Framework
		}
		path += buildQueryString(q)
	}
	return unmarshal[EvidencePack](s.http.get(ctx, path))
}
