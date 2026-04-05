package grantex

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// VaultService handles credential vault operations.
type VaultService struct {
	http *httpClient
}

// StoreCredentialParams contains the parameters for storing a credential in the vault.
type StoreCredentialParams struct {
	PrincipalID    string                 `json:"principalId"`
	Service        string                 `json:"service"`
	CredentialType string                 `json:"credentialType,omitempty"`
	AccessToken    string                 `json:"accessToken"`
	RefreshToken   string                 `json:"refreshToken,omitempty"`
	TokenExpiresAt string                 `json:"tokenExpiresAt,omitempty"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
}

// StoreCredentialResponse is the response from storing a credential.
type StoreCredentialResponse struct {
	ID             string `json:"id"`
	PrincipalID    string `json:"principalId"`
	Service        string `json:"service"`
	CredentialType string `json:"credentialType"`
	CreatedAt      string `json:"createdAt"`
}

// VaultCredential represents a credential record in the vault.
type VaultCredential struct {
	ID             string                 `json:"id"`
	PrincipalID    string                 `json:"principalId"`
	Service        string                 `json:"service"`
	CredentialType string                 `json:"credentialType"`
	TokenExpiresAt *string                `json:"tokenExpiresAt"`
	Metadata       map[string]interface{} `json:"metadata"`
	CreatedAt      string                 `json:"createdAt"`
	UpdatedAt      string                 `json:"updatedAt"`
}

// ListVaultCredentialsParams contains optional filters for listing vault credentials.
type ListVaultCredentialsParams struct {
	PrincipalID string
	Service     string
}

type listVaultCredentialsResponse struct {
	Credentials []VaultCredential `json:"credentials"`
}

// ExchangeCredentialParams contains the parameters for exchanging a grant token for a credential.
type ExchangeCredentialParams struct {
	Service string `json:"service"`
}

// ExchangeCredentialResponse is the response from exchanging a grant token for a credential.
type ExchangeCredentialResponse struct {
	AccessToken    string                 `json:"accessToken"`
	Service        string                 `json:"service"`
	CredentialType string                 `json:"credentialType"`
	TokenExpiresAt *string                `json:"tokenExpiresAt"`
	Metadata       map[string]interface{} `json:"metadata"`
}

// Store saves an encrypted credential in the vault (upserts on principal+service).
func (s *VaultService) Store(ctx context.Context, params StoreCredentialParams) (*StoreCredentialResponse, error) {
	return unmarshal[StoreCredentialResponse](s.http.post(ctx, "/v1/vault/credentials", params))
}

// List retrieves credential metadata (no raw tokens).
func (s *VaultService) List(ctx context.Context, params *ListVaultCredentialsParams) ([]VaultCredential, error) {
	path := "/v1/vault/credentials"
	if params != nil {
		q := url.Values{}
		if params.PrincipalID != "" {
			q.Set("principalId", params.PrincipalID)
		}
		if params.Service != "" {
			q.Set("service", params.Service)
		}
		if qs := q.Encode(); qs != "" {
			path += "?" + qs
		}
	}
	resp, err := unmarshal[listVaultCredentialsResponse](s.http.get(ctx, path))
	if err != nil {
		return nil, err
	}
	return resp.Credentials, nil
}

// Get retrieves credential metadata by ID (no raw token).
func (s *VaultService) Get(ctx context.Context, credentialID string) (*VaultCredential, error) {
	return unmarshal[VaultCredential](s.http.get(ctx, fmt.Sprintf("/v1/vault/credentials/%s", credentialID)))
}

// Delete removes a credential from the vault.
func (s *VaultService) Delete(ctx context.Context, credentialID string) error {
	_, err := s.http.del(ctx, fmt.Sprintf("/v1/vault/credentials/%s", credentialID))
	return err
}

// Exchange trades a grant token for an upstream service credential.
// Unlike other methods, this uses the grant token (not the API key) as the Bearer token.
func (s *VaultService) Exchange(ctx context.Context, grantToken string, params ExchangeCredentialParams) (*ExchangeCredentialResponse, error) {
	reqURL := strings.TrimRight(s.http.baseURL, "/") + "/v1/vault/credentials/exchange"

	body, err := json.Marshal(params)
	if err != nil {
		return nil, &NetworkError{Message: "failed to marshal request body", Cause: err}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
	if err != nil {
		return nil, &NetworkError{Message: "failed to create request", Cause: err}
	}

	req.Header.Set("Authorization", "Bearer "+grantToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "grantex-go/"+sdkVersion)

	resp, err := s.http.client.Do(req)
	if err != nil {
		return nil, &NetworkError{Message: "request failed", Cause: err}
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &NetworkError{Message: "failed to read response body", Cause: err}
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, s.http.parseError(resp.StatusCode, respBody, parseRateLimitHeaders(resp.Header))
	}

	return unmarshal[ExchangeCredentialResponse](respBody, nil)
}
