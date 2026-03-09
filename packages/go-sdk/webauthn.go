package grantex

import (
	"context"
	"fmt"
)

// WebAuthnService handles FIDO2/WebAuthn credential management.
type WebAuthnService struct {
	http *httpClient
}

// WebAuthnRegisterOptionsParams contains the parameters for requesting registration options.
type WebAuthnRegisterOptionsParams struct {
	PrincipalID string `json:"principalId"`
}

// WebAuthnRegistrationOptions contains the challenge and options for WebAuthn registration.
type WebAuthnRegistrationOptions struct {
	ChallengeID string                 `json:"challengeId"`
	Options     map[string]interface{} `json:"options"`
}

// WebAuthnRegisterVerifyParams contains the parameters for verifying a registration response.
type WebAuthnRegisterVerifyParams struct {
	ChallengeID string      `json:"challengeId"`
	Response    interface{} `json:"response"`
}

// WebAuthnCredential represents a registered FIDO2 credential.
type WebAuthnCredential struct {
	ID           string   `json:"id"`
	CredentialID string   `json:"credentialId"`
	PublicKey    string   `json:"publicKey"`
	Counter      int      `json:"counter"`
	Transports   []string `json:"transports"`
	CreatedAt    string   `json:"createdAt"`
}

type listWebAuthnCredentialsResponse struct {
	Credentials []WebAuthnCredential `json:"credentials"`
}

// RegisterOptions requests WebAuthn registration options for a principal.
func (s *WebAuthnService) RegisterOptions(ctx context.Context, params WebAuthnRegisterOptionsParams) (*WebAuthnRegistrationOptions, error) {
	return unmarshal[WebAuthnRegistrationOptions](s.http.post(ctx, "/v1/webauthn/register/options", params))
}

// RegisterVerify verifies a WebAuthn registration response.
func (s *WebAuthnService) RegisterVerify(ctx context.Context, params WebAuthnRegisterVerifyParams) (*WebAuthnCredential, error) {
	return unmarshal[WebAuthnCredential](s.http.post(ctx, "/v1/webauthn/register/verify", params))
}

// ListCredentials lists all WebAuthn credentials for a principal.
func (s *WebAuthnService) ListCredentials(ctx context.Context, principalID string) ([]WebAuthnCredential, error) {
	resp, err := unmarshal[listWebAuthnCredentialsResponse](s.http.get(ctx, fmt.Sprintf("/v1/webauthn/credentials?principalId=%s", principalID)))
	if err != nil {
		return nil, err
	}
	return resp.Credentials, nil
}

// DeleteCredential removes a WebAuthn credential by ID.
func (s *WebAuthnService) DeleteCredential(ctx context.Context, id string) error {
	_, err := s.http.del(ctx, fmt.Sprintf("/v1/webauthn/credentials/%s", id))
	return err
}
