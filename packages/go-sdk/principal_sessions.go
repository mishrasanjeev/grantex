package grantex

import "context"

// PrincipalSessionsService handles principal session management.
type PrincipalSessionsService struct {
	http *httpClient
}

// Create creates a new principal session for end-user dashboard access.
func (s *PrincipalSessionsService) Create(ctx context.Context, params CreatePrincipalSessionParams) (*PrincipalSessionResponse, error) {
	return unmarshal[PrincipalSessionResponse](s.http.post(ctx, "/v1/principal-sessions", params))
}
