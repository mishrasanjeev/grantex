package grantex

import (
	"context"
	"fmt"
)

// DomainsService handles custom domain management.
type DomainsService struct {
	http *httpClient
}

// CreateDomainParams contains the parameters for creating a custom domain.
type CreateDomainParams struct {
	Domain string `json:"domain"`
}

// Domain represents a custom domain record.
type Domain struct {
	ID                string `json:"id"`
	Domain            string `json:"domain"`
	Verified          bool   `json:"verified"`
	VerificationToken string `json:"verificationToken"`
	Instructions      string `json:"instructions"`
	CreatedAt         string `json:"createdAt"`
}

// VerifyDomainResponse is the response from a domain verification operation.
type VerifyDomainResponse struct {
	Verified bool `json:"verified"`
}

type listDomainsResponse struct {
	Domains []Domain `json:"domains"`
}

// Create registers a new custom domain.
func (s *DomainsService) Create(ctx context.Context, params CreateDomainParams) (*Domain, error) {
	return unmarshal[Domain](s.http.post(ctx, "/v1/domains", params))
}

// List retrieves all registered custom domains.
func (s *DomainsService) List(ctx context.Context) ([]Domain, error) {
	resp, err := unmarshal[listDomainsResponse](s.http.get(ctx, "/v1/domains"))
	if err != nil {
		return nil, err
	}
	return resp.Domains, nil
}

// Verify triggers DNS verification for a domain.
func (s *DomainsService) Verify(ctx context.Context, id string) (*VerifyDomainResponse, error) {
	return unmarshal[VerifyDomainResponse](s.http.post(ctx, fmt.Sprintf("/v1/domains/%s/verify", id), nil))
}

// Delete removes a custom domain.
func (s *DomainsService) Delete(ctx context.Context, id string) error {
	_, err := s.http.del(ctx, fmt.Sprintf("/v1/domains/%s", id))
	return err
}
