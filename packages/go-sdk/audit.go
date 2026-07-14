package grantex

import "context"

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
		path += buildQueryString(q)
	}
	return unmarshal[ListAuditResponse](s.http.get(ctx, path))
}

// Get retrieves a single audit entry by ID.
func (s *AuditService) Get(ctx context.Context, entryID string) (*AuditEntry, error) {
	return unmarshal[AuditEntry](s.http.get(ctx, "/v1/audit/"+entryID))
}
