package grantex

import (
	"context"
	"fmt"
)

// GrantsService handles grant management and delegation.
type GrantsService struct {
	http *httpClient
}

// Get retrieves a grant by ID.
func (s *GrantsService) Get(ctx context.Context, grantID string) (*Grant, error) {
	return unmarshal[Grant](s.http.get(ctx, "/v1/grants/"+grantID))
}

// List retrieves grants with optional filters.
func (s *GrantsService) List(ctx context.Context, params *ListGrantsParams) (*ListGrantsResponse, error) {
	path := "/v1/grants"
	if params != nil {
		q := make(map[string]string)
		if params.AgentID != "" {
			q["agentId"] = params.AgentID
		}
		if params.PrincipalID != "" {
			q["principalId"] = params.PrincipalID
		}
		if params.Status != "" {
			q["status"] = params.Status
		}
		if params.Page > 0 {
			q["page"] = fmt.Sprintf("%d", params.Page)
		}
		if params.PageSize > 0 {
			q["pageSize"] = fmt.Sprintf("%d", params.PageSize)
		}
		path += buildQueryString(q)
	}
	return unmarshal[ListGrantsResponse](s.http.get(ctx, path))
}

// Revoke revokes a grant by ID.
func (s *GrantsService) Revoke(ctx context.Context, grantID string) error {
	_, err := s.http.del(ctx, "/v1/grants/"+grantID)
	return err
}

// Delegate creates a delegated grant for a sub-agent.
func (s *GrantsService) Delegate(ctx context.Context, params DelegateParams) (*DelegateResponse, error) {
	return unmarshal[DelegateResponse](s.http.post(ctx, "/v1/grants/delegate", params))
}
