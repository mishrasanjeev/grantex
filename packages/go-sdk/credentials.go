package grantex

import (
	"context"
	"fmt"
	"net/url"
)

// CredentialsService handles Verifiable Credential operations.
type CredentialsService struct {
	http *httpClient
}

// VerifiableCredentialRecord represents a Verifiable Credential record.
type VerifiableCredentialRecord struct {
	ID           string   `json:"id"`
	Type         []string `json:"type"`
	Issuer       string   `json:"issuer"`
	Subject      string   `json:"subject"`
	GrantID      string   `json:"grantId"`
	Status       string   `json:"status"`
	IssuanceDate string   `json:"issuanceDate"`
	JWT          string   `json:"jwt"`
}

// ListCredentialsParams contains optional filters for listing credentials.
type ListCredentialsParams struct {
	GrantID string
	Status  string
}

// VCVerificationResult is the result of verifying a Verifiable Credential.
type VCVerificationResult struct {
	Valid             bool                   `json:"valid"`
	CredentialSubject map[string]interface{} `json:"credentialSubject"`
	Issuer            string                 `json:"issuer"`
	Error             string                 `json:"error,omitempty"`
}

// SDJWTPresentParams contains the parameters for creating an SD-JWT presentation.
type SDJWTPresentParams struct {
	SDJWT           string   `json:"sdJwt"`
	DisclosedClaims []string `json:"disclosedClaims"`
}

// SDJWTPresentResult is the result of creating an SD-JWT presentation.
type SDJWTPresentResult struct {
	Presentation string `json:"presentation"`
}

type listCredentialsResponse struct {
	Credentials []VerifiableCredentialRecord `json:"credentials"`
}

// Get retrieves a Verifiable Credential by ID.
func (s *CredentialsService) Get(ctx context.Context, id string) (*VerifiableCredentialRecord, error) {
	return unmarshal[VerifiableCredentialRecord](s.http.get(ctx, fmt.Sprintf("/v1/credentials/%s", id)))
}

// List retrieves Verifiable Credentials with optional filters.
func (s *CredentialsService) List(ctx context.Context, params *ListCredentialsParams) ([]VerifiableCredentialRecord, error) {
	path := "/v1/credentials"
	if params != nil {
		q := url.Values{}
		if params.GrantID != "" {
			q.Set("grantId", params.GrantID)
		}
		if params.Status != "" {
			q.Set("status", params.Status)
		}
		if qs := q.Encode(); qs != "" {
			path += "?" + qs
		}
	}
	resp, err := unmarshal[listCredentialsResponse](s.http.get(ctx, path))
	if err != nil {
		return nil, err
	}
	return resp.Credentials, nil
}

// Verify verifies a VC-JWT.
func (s *CredentialsService) Verify(ctx context.Context, vcJWT string) (*VCVerificationResult, error) {
	return unmarshal[VCVerificationResult](s.http.post(ctx, "/v1/credentials/verify", map[string]string{"vcJwt": vcJWT}))
}

// Present creates an SD-JWT presentation with selective disclosure.
func (s *CredentialsService) Present(ctx context.Context, params SDJWTPresentParams) (*SDJWTPresentResult, error) {
	return unmarshal[SDJWTPresentResult](s.http.post(ctx, "/v1/credentials/present", params))
}
