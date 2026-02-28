package grantex

import "context"

// SSOService handles SSO configuration and authentication.
type SSOService struct {
	http *httpClient
}

// CreateConfig creates an SSO configuration.
func (s *SSOService) CreateConfig(ctx context.Context, params CreateSsoConfigParams) (*SsoConfig, error) {
	return unmarshal[SsoConfig](s.http.post(ctx, "/v1/sso/config", params))
}

// GetConfig retrieves the current SSO configuration.
func (s *SSOService) GetConfig(ctx context.Context) (*SsoConfig, error) {
	return unmarshal[SsoConfig](s.http.get(ctx, "/v1/sso/config"))
}

// DeleteConfig removes the SSO configuration.
func (s *SSOService) DeleteConfig(ctx context.Context) error {
	_, err := s.http.del(ctx, "/v1/sso/config")
	return err
}

// GetLoginURL gets the SSO login URL for an organization.
func (s *SSOService) GetLoginURL(ctx context.Context, org string) (*SsoLoginResponse, error) {
	return unmarshal[SsoLoginResponse](s.http.get(ctx, "/v1/sso/login?org="+org))
}

// HandleCallback processes an SSO callback.
func (s *SSOService) HandleCallback(ctx context.Context, code string, state string) (*SsoCallbackResponse, error) {
	body := map[string]string{
		"code":  code,
		"state": state,
	}
	return unmarshal[SsoCallbackResponse](s.http.post(ctx, "/v1/sso/callback", body))
}
