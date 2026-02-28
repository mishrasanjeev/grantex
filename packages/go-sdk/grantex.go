// Package grantex provides a Go SDK for the Grantex delegated authorization protocol.
//
// Create a client with NewClient and use its resource services (Agents, Tokens, Grants, etc.)
// to interact with the Grantex API.
//
//	client := grantex.NewClient("your-api-key")
//	agent, err := client.Agents.Register(ctx, grantex.RegisterAgentParams{
//	    Name:        "My Agent",
//	    Description: "An AI assistant",
//	    Scopes:      []string{"read:email", "send:email"},
//	})
package grantex

import (
	"context"
	"net/http"
	"time"
)

const defaultBaseURL = "https://api.grantex.dev"
const defaultTimeout = 30 * time.Second

// Client is the main entry point for the Grantex SDK.
type Client struct {
	Agents            *AgentsService
	Tokens            *TokensService
	Grants            *GrantsService
	Audit             *AuditService
	Webhooks          *WebhooksService
	Billing           *BillingService
	Policies          *PoliciesService
	Compliance        *ComplianceService
	Anomalies         *AnomaliesService
	SCIM              *SCIMService
	SSO               *SSOService
	PrincipalSessions *PrincipalSessionsService

	http *httpClient
}

// NewClient creates a new Grantex API client.
func NewClient(apiKey string, opts ...Option) *Client {
	cfg := &clientConfig{
		baseURL: defaultBaseURL,
		timeout: defaultTimeout,
	}
	for _, opt := range opts {
		opt(cfg)
	}

	hc := cfg.httpClient
	if hc == nil {
		hc = &http.Client{Timeout: cfg.timeout}
	}

	h := &httpClient{
		baseURL: cfg.baseURL,
		apiKey:  apiKey,
		client:  hc,
	}

	c := &Client{http: h}
	c.Agents = &AgentsService{http: h}
	c.Tokens = &TokensService{http: h}
	c.Grants = &GrantsService{http: h}
	c.Audit = &AuditService{http: h}
	c.Webhooks = &WebhooksService{http: h}
	c.Billing = &BillingService{http: h}
	c.Policies = &PoliciesService{http: h}
	c.Compliance = &ComplianceService{http: h}
	c.Anomalies = &AnomaliesService{http: h}
	c.SCIM = &SCIMService{http: h}
	c.SSO = &SSOService{http: h}
	c.PrincipalSessions = &PrincipalSessionsService{http: h}

	return c
}

// Signup registers a new developer account. This is a static operation that does not require an API key.
func Signup(ctx context.Context, params SignupParams, opts ...Option) (*SignupResponse, error) {
	cfg := &clientConfig{
		baseURL: defaultBaseURL,
		timeout: defaultTimeout,
	}
	for _, opt := range opts {
		opt(cfg)
	}

	hc := cfg.httpClient
	if hc == nil {
		hc = &http.Client{Timeout: cfg.timeout}
	}

	h := &httpClient{
		baseURL: cfg.baseURL,
		apiKey:  "",
		client:  hc,
	}

	return unmarshal[SignupResponse](h.post(ctx, "/v1/developers/signup", params))
}

// Authorize creates an authorization request for a user to grant permissions to an agent.
func (c *Client) Authorize(ctx context.Context, params AuthorizeParams) (*AuthorizationRequest, error) {
	return unmarshal[AuthorizationRequest](c.http.post(ctx, "/v1/authorize", params))
}

// RotateKey rotates the developer API key.
func (c *Client) RotateKey(ctx context.Context) (*RotateKeyResponse, error) {
	return unmarshal[RotateKeyResponse](c.http.post(ctx, "/v1/developers/rotate-key", nil))
}
