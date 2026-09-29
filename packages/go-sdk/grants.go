package grantex

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/golang-jwt/jwt/v5"
)

// GrantsService handles grant management and delegation.
type GrantsService struct {
	http *httpClient
}

// Verify checks current issuer authority. Unlike VerifyGrantToken, this calls
// the issuer for every token, without a positive authorization cache.
func (s *GrantsService) Verify(ctx context.Context, token string) (*VerifiedGrant, error) {
	data, err := s.http.post(ctx, "/v1/grants/verify", map[string]string{"token": token})
	if err != nil {
		return nil, err
	}
	var response struct {
		Active bool          `json:"active"`
		Claims jwt.MapClaims `json:"claims"`
	}
	if err := json.Unmarshal(data, &response); err != nil || !response.Active || response.Claims == nil {
		return nil, &TokenError{Message: "grant token is not active or authority response is malformed", Cause: err}
	}
	return normalizeGrantClaims(response.Claims, true)
}

// Get retrieves a grant by ID.
func (s *GrantsService) Get(ctx context.Context, grantID string) (*Grant, error) {
	return unmarshal[Grant](s.http.get(ctx, "/v1/grants/"+url.PathEscape(grantID)))
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
	_, err := s.http.del(ctx, "/v1/grants/"+url.PathEscape(grantID))
	return err
}

// Delegate creates a delegated grant for a sub-agent.
func (s *GrantsService) Delegate(ctx context.Context, params DelegateParams) (*DelegateResponse, error) {
	return unmarshal[DelegateResponse](s.http.post(ctx, "/v1/grants/delegate", params))
}
