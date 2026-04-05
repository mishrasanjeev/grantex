package grantex

import (
	"context"
	"fmt"
	"net/url"
)

// PassportsService handles Agent Passport Credential operations.
type PassportsService struct {
	http *httpClient
}

// IssuePassportParams contains the parameters for issuing an agent passport.
type IssuePassportParams struct {
	AgentID               string              `json:"agentId"`
	GrantID               string              `json:"grantId"`
	AllowedMPPCategories  []string            `json:"allowedMPPCategories"`
	MaxTransactionAmount  TransactionAmount   `json:"maxTransactionAmount"`
	PaymentRails          []string            `json:"paymentRails,omitempty"`
	ExpiresIn             string              `json:"expiresIn,omitempty"`
	ParentPassportID      string              `json:"parentPassportId,omitempty"`
}

// TransactionAmount represents a monetary amount with currency.
type TransactionAmount struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

// IssuedPassportResponse is the response from issuing an agent passport.
type IssuedPassportResponse struct {
	PassportID        string                 `json:"passportId"`
	Credential        map[string]interface{} `json:"credential"`
	EncodedCredential string                 `json:"encodedCredential"`
	ExpiresAt         string                 `json:"expiresAt"`
}

// GetPassportResponse is the response from getting a passport by ID.
type GetPassportResponse struct {
	Status string `json:"status"`
	// Additional dynamic fields are not mapped; use raw JSON if needed.
}

// RevokePassportResponse is the response from revoking a passport.
type RevokePassportResponse struct {
	Revoked   bool   `json:"revoked"`
	RevokedAt string `json:"revokedAt"`
}

// ListPassportsParams contains optional filters for listing passports.
type ListPassportsParams struct {
	AgentID string
	GrantID string
	Status  string
}

// Issue creates a new Agent Passport Credential.
func (s *PassportsService) Issue(ctx context.Context, params IssuePassportParams) (*IssuedPassportResponse, error) {
	return unmarshal[IssuedPassportResponse](s.http.post(ctx, "/v1/passport/issue", params))
}

// Get retrieves a passport by ID.
func (s *PassportsService) Get(ctx context.Context, passportID string) (*GetPassportResponse, error) {
	return unmarshal[GetPassportResponse](s.http.get(ctx, fmt.Sprintf("/v1/passport/%s", url.PathEscape(passportID))))
}

// Revoke revokes a passport by ID.
func (s *PassportsService) Revoke(ctx context.Context, passportID string) (*RevokePassportResponse, error) {
	return unmarshal[RevokePassportResponse](s.http.post(ctx, fmt.Sprintf("/v1/passport/%s/revoke", url.PathEscape(passportID)), nil))
}

// List retrieves passports with optional filters.
func (s *PassportsService) List(ctx context.Context, params *ListPassportsParams) ([]IssuedPassportResponse, error) {
	path := "/v1/passports"
	if params != nil {
		q := url.Values{}
		if params.AgentID != "" {
			q.Set("agentId", params.AgentID)
		}
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
	// API returns a bare JSON array, not a wrapped object
	resp, err := unmarshalSlice[IssuedPassportResponse](s.http.get(ctx, path))
	if err != nil {
		return nil, err
	}
	return resp, nil
}
