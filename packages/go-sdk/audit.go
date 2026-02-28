package grantex

import (
	"context"
	"fmt"
)

// AuditService handles audit logging and retrieval.
type AuditService struct {
	http *httpClient
}

// Log creates an audit log entry.
func (s *AuditService) Log(ctx context.Context, params LogAuditParams) (*AuditEntry, error) {
	return unmarshal[AuditEntry](s.http.post(ctx, "/v1/audit/log", params))
}

// List retrieves audit log entries with optional filters.
func (s *AuditService) List(ctx context.Context, params *ListAuditParams) (*ListAuditResponse, error) {
	path := "/v1/audit/entries"
	if params != nil {
		q := make(map[string]string)
		if params.AgentID != "" {
			q["agentId"] = params.AgentID
		}
		if params.GrantID != "" {
			q["grantId"] = params.GrantID
		}
		if params.PrincipalID != "" {
			q["principalId"] = params.PrincipalID
		}
		if params.Action != "" {
			q["action"] = params.Action
		}
		if params.Since != "" {
			q["since"] = params.Since
		}
		if params.Until != "" {
			q["until"] = params.Until
		}
		if params.Page > 0 {
			q["page"] = fmt.Sprintf("%d", params.Page)
		}
		if params.PageSize > 0 {
			q["pageSize"] = fmt.Sprintf("%d", params.PageSize)
		}
		path += buildQueryString(q)
	}
	return unmarshal[ListAuditResponse](s.http.get(ctx, path))
}

// Get retrieves a single audit entry by ID.
func (s *AuditService) Get(ctx context.Context, entryID string) (*AuditEntry, error) {
	return unmarshal[AuditEntry](s.http.get(ctx, "/v1/audit/"+entryID))
}
