package grantex

import (
	"context"
	"fmt"
	"net/url"
)

// WebAuthnService handles FIDO2/WebAuthn credential management.
type WebAuthnService struct {
	http *httpClient
}

// WebAuthnEnrollmentSession contains a one-use hosted enrollment link.
type WebAuthnEnrollmentSession struct {
	EnrollmentURL string `json:"enrollmentUrl"`
	ExpiresAt     string `json:"expiresAt"`
}

type WebAuthnEnrollmentSessionParams struct {
	PrincipalID   string `json:"principalId"`
	AuthRequestID string `json:"authRequestId,omitempty"`
}

// CreateEnrollmentSession must be called only after the application authenticates the principal.
func (s *WebAuthnService) CreateEnrollmentSession(ctx context.Context, params WebAuthnEnrollmentSessionParams) (*WebAuthnEnrollmentSession, error) {
	return unmarshal[WebAuthnEnrollmentSession](s.http.post(ctx, "/v1/webauthn/enrollment-sessions", params))
}

// WebAuthnRegisterOptionsParams contains the parameters for requesting registration options.
type WebAuthnRegisterOptionsParams struct {
	PrincipalID string `json:"principalId"`
}

// WebAuthnRegistrationOptions contains the challenge and options for WebAuthn registration.
type WebAuthnRegistrationOptions struct {
	ChallengeID string                 `json:"challengeId"`
	PublicKey   map[string]interface{} `json:"publicKey"`
	// Options is retained for callers of older source versions.
	Options map[string]interface{} `json:"-"`
}

// WebAuthnRegisterVerifyParams contains the parameters for verifying a registration response.
type WebAuthnRegisterVerifyParams struct {
	ChallengeID string      `json:"challengeId"`
	Response    interface{} `json:"response"`
}

// WebAuthnCredential represents a registered FIDO2 credential.
type WebAuthnCredential struct {
	ID          string   `json:"id"`
	PrincipalID string   `json:"principalId"`
	DeviceName  *string  `json:"deviceName"`
	BackedUp    bool     `json:"backedUp"`
	Transports  []string `json:"transports"`
	CreatedAt   string   `json:"createdAt"`
	LastUsedAt  *string  `json:"lastUsedAt"`
	// Legacy fields retained for source compatibility. The API does not return
	// credential material or its counter to clients.
	CredentialID string `json:"-"`
	PublicKey    string `json:"-"`
	Counter      int    `json:"-"`
}

type listWebAuthnCredentialsResponse struct {
	Credentials []WebAuthnCredential `json:"credentials"`
}

// RegisterOptions requests WebAuthn registration options for a principal.
func (s *WebAuthnService) RegisterOptions(ctx context.Context, params WebAuthnRegisterOptionsParams) (*WebAuthnRegistrationOptions, error) {
	result, err := unmarshal[WebAuthnRegistrationOptions](s.http.post(ctx, "/v1/webauthn/register/options", params))
	if err != nil {
		return nil, err
	}
	result.Options = result.PublicKey
	return result, nil
}

// RegisterVerify verifies a WebAuthn registration response.
func (s *WebAuthnService) RegisterVerify(ctx context.Context, params WebAuthnRegisterVerifyParams) (*WebAuthnCredential, error) {
	return unmarshal[WebAuthnCredential](s.http.post(ctx, "/v1/webauthn/register/verify", params))
}

// ListCredentials lists all WebAuthn credentials for a principal.
func (s *WebAuthnService) ListCredentials(ctx context.Context, principalID string) ([]WebAuthnCredential, error) {
	path := "/v1/webauthn/credentials" + buildQueryString(map[string]string{
		"principalId": principalID,
	})
	resp, err := unmarshal[listWebAuthnCredentialsResponse](s.http.get(ctx, path))
	if err != nil {
		return nil, err
	}
	return resp.Credentials, nil
}

// DeleteCredential removes a WebAuthn credential by ID.
func (s *WebAuthnService) DeleteCredential(ctx context.Context, id string) error {
	_, err := s.http.del(ctx, fmt.Sprintf("/v1/webauthn/credentials/%s", url.PathEscape(id)))
	return err
}
