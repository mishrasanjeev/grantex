package grantex

import (
	"context"
	"net/url"
)

// SSOService handles SSO configuration, connections, and authentication.
type SSOService struct {
	http *httpClient
}

// --- Enterprise SSO Connections ---

// CreateConnection creates a new SSO connection (OIDC or SAML).
func (s *SSOService) CreateConnection(ctx context.Context, params CreateSsoConnectionParams) (*SsoConnection, error) {
	return unmarshal[SsoConnection](s.http.post(ctx, "/v1/sso/connections", params))
}

// ListConnections lists all SSO connections.
func (s *SSOService) ListConnections(ctx context.Context) (*ListSsoConnectionsResponse, error) {
	return unmarshal[ListSsoConnectionsResponse](s.http.get(ctx, "/v1/sso/connections"))
}

// GetConnection retrieves an SSO connection by ID.
func (s *SSOService) GetConnection(ctx context.Context, id string) (*SsoConnection, error) {
	return unmarshal[SsoConnection](s.http.get(ctx, "/v1/sso/connections/"+id))
}

// UpdateConnection updates an existing SSO connection.
func (s *SSOService) UpdateConnection(ctx context.Context, id string, params UpdateSsoConnectionParams) (*SsoConnection, error) {
	return unmarshal[SsoConnection](s.http.patch(ctx, "/v1/sso/connections/"+id, params))
}

// DeleteConnection deletes an SSO connection.
func (s *SSOService) DeleteConnection(ctx context.Context, id string) error {
	_, err := s.http.del(ctx, "/v1/sso/connections/"+id)
	return err
}

// TestConnection tests an SSO connection's configuration.
func (s *SSOService) TestConnection(ctx context.Context, id string) (*SsoConnectionTestResult, error) {
	return unmarshal[SsoConnectionTestResult](s.http.post(ctx, "/v1/sso/connections/"+id+"/test", nil))
}

// --- SSO Enforcement ---

// SetEnforcement configures SSO enforcement settings.
func (s *SSOService) SetEnforcement(ctx context.Context, params SsoEnforcementParams) (*SsoEnforcementResponse, error) {
	return unmarshal[SsoEnforcementResponse](s.http.post(ctx, "/v1/sso/enforcement", params))
}

// --- SSO Sessions ---

// ListSessions lists active SSO sessions.
func (s *SSOService) ListSessions(ctx context.Context) (*ListSsoSessionsResponse, error) {
	return unmarshal[ListSsoSessionsResponse](s.http.get(ctx, "/v1/sso/sessions"))
}

// RevokeSession revokes an SSO session by ID.
func (s *SSOService) RevokeSession(ctx context.Context, id string) error {
	_, err := s.http.del(ctx, "/v1/sso/sessions/"+id)
	return err
}

// --- Login Flow ---

// GetLoginURL gets the SSO login URL for an organization, with an optional domain hint.
func (s *SSOService) GetLoginURL(ctx context.Context, org string, domain ...string) (*SsoLoginResponse, error) {
	q := url.Values{}
	q.Set("org", org)
	if len(domain) > 0 && domain[0] != "" {
		q.Set("domain", domain[0])
	}
	return unmarshal[SsoLoginResponse](s.http.get(ctx, "/v1/sso/login?"+q.Encode()))
}

// HandleOidcCallback processes an OIDC SSO callback.
func (s *SSOService) HandleOidcCallback(ctx context.Context, params SsoOidcCallbackParams) (*SsoCallbackResult, error) {
	return unmarshal[SsoCallbackResult](s.http.post(ctx, "/v1/sso/callback/oidc", params))
}

// HandleSamlCallback processes a SAML SSO callback.
func (s *SSOService) HandleSamlCallback(ctx context.Context, params SsoSamlCallbackParams) (*SsoCallbackResult, error) {
	return unmarshal[SsoCallbackResult](s.http.post(ctx, "/v1/sso/callback/saml", params))
}

// HandleLdapCallback processes an LDAP SSO callback with bind authentication.
func (s *SSOService) HandleLdapCallback(ctx context.Context, params SsoLdapCallbackParams) (*SsoCallbackResult, error) {
	return unmarshal[SsoCallbackResult](s.http.post(ctx, "/v1/sso/callback/ldap", params))
}

// --- Legacy (kept for backward compatibility) ---

// CreateConfig creates an SSO configuration.
// Deprecated: Use CreateConnection for enterprise SSO.
func (s *SSOService) CreateConfig(ctx context.Context, params CreateSsoConfigParams) (*SsoConfig, error) {
	return unmarshal[SsoConfig](s.http.post(ctx, "/v1/sso/config", params))
}

// GetConfig retrieves the current SSO configuration.
// Deprecated: Use ListConnections for enterprise SSO.
func (s *SSOService) GetConfig(ctx context.Context) (*SsoConfig, error) {
	return unmarshal[SsoConfig](s.http.get(ctx, "/v1/sso/config"))
}

// DeleteConfig removes the SSO configuration.
// Deprecated: Use DeleteConnection for enterprise SSO.
func (s *SSOService) DeleteConfig(ctx context.Context) error {
	_, err := s.http.del(ctx, "/v1/sso/config")
	return err
}

// HandleCallback processes an SSO callback.
// Deprecated: Use HandleOidcCallback or HandleSamlCallback for enterprise SSO.
func (s *SSOService) HandleCallback(ctx context.Context, code string, state string) (*SsoCallbackResponse, error) {
	body := map[string]string{
		"code":  code,
		"state": state,
	}
	return unmarshal[SsoCallbackResponse](s.http.post(ctx, "/v1/sso/callback", body))
}
