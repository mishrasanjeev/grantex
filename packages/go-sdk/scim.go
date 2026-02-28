package grantex

import (
	"context"
	"fmt"
)

// SCIMService handles SCIM 2.0 provisioning operations.
type SCIMService struct {
	http *httpClient
}

// CreateToken creates a new SCIM provisioning token.
func (s *SCIMService) CreateToken(ctx context.Context, label string) (*ScimTokenWithSecret, error) {
	body := CreateScimTokenParams{Label: label}
	return unmarshal[ScimTokenWithSecret](s.http.post(ctx, "/v1/scim/tokens", body))
}

// ListTokens retrieves all SCIM provisioning tokens.
func (s *SCIMService) ListTokens(ctx context.Context) (*ListScimTokensResponse, error) {
	return unmarshal[ListScimTokensResponse](s.http.get(ctx, "/v1/scim/tokens"))
}

// RevokeToken revokes a SCIM provisioning token.
func (s *SCIMService) RevokeToken(ctx context.Context, tokenID string) error {
	_, err := s.http.del(ctx, "/v1/scim/tokens/"+tokenID)
	return err
}

// ListUsers retrieves SCIM users with optional pagination.
func (s *SCIMService) ListUsers(ctx context.Context, params *ListScimUsersParams) (*ScimListResponse, error) {
	path := "/v1/scim/v2/Users"
	if params != nil {
		q := make(map[string]string)
		if params.StartIndex > 0 {
			q["startIndex"] = fmt.Sprintf("%d", params.StartIndex)
		}
		if params.Count > 0 {
			q["count"] = fmt.Sprintf("%d", params.Count)
		}
		path += buildQueryString(q)
	}
	return unmarshal[ScimListResponse](s.http.get(ctx, path))
}

// GetUser retrieves a SCIM user by ID.
func (s *SCIMService) GetUser(ctx context.Context, userID string) (*ScimUser, error) {
	return unmarshal[ScimUser](s.http.get(ctx, "/v1/scim/v2/Users/"+userID))
}

// CreateUser creates a new SCIM user.
func (s *SCIMService) CreateUser(ctx context.Context, params CreateScimUserParams) (*ScimUser, error) {
	return unmarshal[ScimUser](s.http.post(ctx, "/v1/scim/v2/Users", params))
}

// ReplaceUser replaces a SCIM user (PUT).
func (s *SCIMService) ReplaceUser(ctx context.Context, userID string, params CreateScimUserParams) (*ScimUser, error) {
	return unmarshal[ScimUser](s.http.put(ctx, "/v1/scim/v2/Users/"+userID, params))
}

// UpdateUser performs a SCIM PATCH operation on a user.
func (s *SCIMService) UpdateUser(ctx context.Context, userID string, ops []ScimOperation) (*ScimUser, error) {
	body := map[string]interface{}{
		"Operations": ops,
	}
	return unmarshal[ScimUser](s.http.patch(ctx, "/v1/scim/v2/Users/"+userID, body))
}

// DeleteUser removes a SCIM user.
func (s *SCIMService) DeleteUser(ctx context.Context, userID string) error {
	_, err := s.http.del(ctx, "/v1/scim/v2/Users/"+userID)
	return err
}
