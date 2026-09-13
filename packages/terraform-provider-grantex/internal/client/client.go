package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Client is an HTTP client for the Grantex API.
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

// NewClient creates a new Grantex API client.
func NewClient(apiKey, baseURL string) *Client {
	return &Client{
		BaseURL: baseURL,
		APIKey:  apiKey,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// ---------- Agent ----------

// Agent represents a Grantex agent resource.
type Agent struct {
	AgentID     string   `json:"agentId"`
	DID         string   `json:"did"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Scopes      []string `json:"scopes"`
	Status      string   `json:"status"`
	CreatedAt   string   `json:"createdAt"`
	UpdatedAt   string   `json:"updatedAt"`
}

// CreateAgentRequest is the request body for creating an agent.
type CreateAgentRequest struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Scopes      []string `json:"scopes"`
}

// UpdateAgentRequest is the request body for updating an agent.
//
// PATCH /v1/agents/:id keeps the current value for every key that is absent,
// so a field that should be cleared must be sent explicitly. Description is a
// pointer for that reason: nil omits the key (keep), a pointer to "" clears it.
// The API rejects a JSON null for description (400), hence "" rather than null.
type UpdateAgentRequest struct {
	Name        string   `json:"name,omitempty"`
	Description *string  `json:"description,omitempty"`
	Scopes      []string `json:"scopes,omitempty"`
}

// CreateAgent creates a new agent.
func (c *Client) CreateAgent(req CreateAgentRequest) (*Agent, error) {
	var agent Agent
	err := c.doRequest("POST", "/v1/agents", req, &agent)
	if err != nil {
		return nil, err
	}
	return &agent, nil
}

// GetAgent retrieves an agent by ID.
func (c *Client) GetAgent(agentID string) (*Agent, error) {
	var agent Agent
	err := c.doRequest("GET", fmt.Sprintf("/v1/agents/%s", url.PathEscape(agentID)), nil, &agent)
	if err != nil {
		return nil, err
	}
	return &agent, nil
}

// UpdateAgent updates an existing agent.
func (c *Client) UpdateAgent(agentID string, req UpdateAgentRequest) (*Agent, error) {
	var agent Agent
	err := c.doRequest("PATCH", fmt.Sprintf("/v1/agents/%s", url.PathEscape(agentID)), req, &agent)
	if err != nil {
		return nil, err
	}
	return &agent, nil
}

// DeleteAgent deletes an agent by ID.
func (c *Client) DeleteAgent(agentID string) error {
	return c.doRequest("DELETE", fmt.Sprintf("/v1/agents/%s", url.PathEscape(agentID)), nil, nil)
}

// ---------- Policy ----------

// Policy represents a Grantex policy resource.
type Policy struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Effect         string   `json:"effect"`
	Priority       int64    `json:"priority"`
	AgentID        string   `json:"agentId,omitempty"`
	PrincipalID    string   `json:"principalId,omitempty"`
	Scopes         []string `json:"scopes,omitempty"`
	TimeOfDayStart string   `json:"timeOfDayStart,omitempty"`
	TimeOfDayEnd   string   `json:"timeOfDayEnd,omitempty"`
	CreatedAt      string   `json:"createdAt"`
	UpdatedAt      string   `json:"updatedAt"`
}

// CreatePolicyRequest is the request body for creating a policy.
type CreatePolicyRequest struct {
	Name           string   `json:"name"`
	Effect         string   `json:"effect"`
	Priority       int64    `json:"priority,omitempty"`
	AgentID        string   `json:"agentId,omitempty"`
	PrincipalID    string   `json:"principalId,omitempty"`
	Scopes         []string `json:"scopes,omitempty"`
	TimeOfDayStart string   `json:"timeOfDayStart,omitempty"`
	TimeOfDayEnd   string   `json:"timeOfDayEnd,omitempty"`
}

// UpdatePolicyRequest is the request body for updating a policy.
//
// PATCH /v1/policies/:id treats an absent key as "keep the current value" and
// an explicit null as "clear the value". No field uses omitempty so that a
// zero priority, a removed agent/principal filter, a removed scope list or a
// removed time window is actually sent (as 0 or null) instead of being
// dropped from the request and silently kept server-side.
type UpdatePolicyRequest struct {
	Name           string   `json:"name"`
	Effect         string   `json:"effect"`
	Priority       int64    `json:"priority"`
	AgentID        *string  `json:"agentId"`
	PrincipalID    *string  `json:"principalId"`
	Scopes         []string `json:"scopes"`
	TimeOfDayStart *string  `json:"timeOfDayStart"`
	TimeOfDayEnd   *string  `json:"timeOfDayEnd"`
}

// CreatePolicy creates a new policy.
func (c *Client) CreatePolicy(req CreatePolicyRequest) (*Policy, error) {
	var policy Policy
	err := c.doRequest("POST", "/v1/policies", req, &policy)
	if err != nil {
		return nil, err
	}
	return &policy, nil
}

// GetPolicy retrieves a policy by ID.
func (c *Client) GetPolicy(id string) (*Policy, error) {
	var policy Policy
	err := c.doRequest("GET", fmt.Sprintf("/v1/policies/%s", url.PathEscape(id)), nil, &policy)
	if err != nil {
		return nil, err
	}
	return &policy, nil
}

// UpdatePolicy updates an existing policy.
func (c *Client) UpdatePolicy(id string, req UpdatePolicyRequest) (*Policy, error) {
	var policy Policy
	err := c.doRequest("PATCH", fmt.Sprintf("/v1/policies/%s", url.PathEscape(id)), req, &policy)
	if err != nil {
		return nil, err
	}
	return &policy, nil
}

// DeletePolicy deletes a policy by ID.
func (c *Client) DeletePolicy(id string) error {
	return c.doRequest("DELETE", fmt.Sprintf("/v1/policies/%s", url.PathEscape(id)), nil, nil)
}

// ---------- Webhook ----------

// Webhook represents a Grantex webhook resource.
//
// Secret is generated server-side and returned only by POST /v1/webhooks;
// the list endpoint never includes it.
type Webhook struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	Secret    string   `json:"secret,omitempty"`
	CreatedAt string   `json:"createdAt"`
}

// CreateWebhookRequest is the request body for creating a webhook.
// The API does not accept a caller-supplied secret.
type CreateWebhookRequest struct {
	URL    string   `json:"url"`
	Events []string `json:"events"`
}

// ListWebhooksResponse is the response from listing webhooks.
type ListWebhooksResponse struct {
	Webhooks []Webhook `json:"webhooks"`
}

// CreateWebhook creates a new webhook.
func (c *Client) CreateWebhook(req CreateWebhookRequest) (*Webhook, error) {
	var webhook Webhook
	err := c.doRequest("POST", "/v1/webhooks", req, &webhook)
	if err != nil {
		return nil, err
	}
	return &webhook, nil
}

// ListWebhooks lists all webhooks for the developer.
func (c *Client) ListWebhooks() ([]Webhook, error) {
	var resp ListWebhooksResponse
	err := c.doRequest("GET", "/v1/webhooks", nil, &resp)
	if err != nil {
		return nil, err
	}
	return resp.Webhooks, nil
}

// GetWebhook retrieves a webhook by ID.
//
// The API exposes no GET /v1/webhooks/:id, so this lists the developer's
// webhooks and picks the matching one. A missing webhook is reported as a
// 404 APIError so callers can treat it like any other not-found response.
func (c *Client) GetWebhook(id string) (*Webhook, error) {
	webhooks, err := c.ListWebhooks()
	if err != nil {
		return nil, err
	}
	for i := range webhooks {
		if webhooks[i].ID == id {
			w := webhooks[i]
			return &w, nil
		}
	}
	return nil, &APIError{StatusCode: http.StatusNotFound, Message: "Webhook not found", Code: "NOT_FOUND"}
}

// DeleteWebhook deletes a webhook by ID.
func (c *Client) DeleteWebhook(id string) error {
	return c.doRequest("DELETE", fmt.Sprintf("/v1/webhooks/%s", url.PathEscape(id)), nil, nil)
}

// ---------- SSO Config ----------

// SSOConfig represents the organisation's OIDC SSO configuration as returned by
// GET/POST /v1/sso/config. The client secret is never returned.
type SSOConfig struct {
	IssuerURL   string `json:"issuerUrl"`
	ClientID    string `json:"clientId"`
	RedirectURI string `json:"redirectUri"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

// UpsertSSOConfigRequest is the request body for creating/updating the SSO config.
type UpsertSSOConfigRequest struct {
	IssuerURL    string `json:"issuerUrl"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	RedirectURI  string `json:"redirectUri"`
}

// UpsertSSOConfig creates or updates the SSO configuration (POST is an upsert).
func (c *Client) UpsertSSOConfig(req UpsertSSOConfigRequest) (*SSOConfig, error) {
	var config SSOConfig
	err := c.doRequest("POST", "/v1/sso/config", req, &config)
	if err != nil {
		return nil, err
	}
	return &config, nil
}

// GetSSOConfig retrieves the SSO configuration.
func (c *Client) GetSSOConfig() (*SSOConfig, error) {
	var config SSOConfig
	err := c.doRequest("GET", "/v1/sso/config", nil, &config)
	if err != nil {
		return nil, err
	}
	return &config, nil
}

// DeleteSSOConfig deletes the SSO configuration.
func (c *Client) DeleteSSOConfig() error {
	return c.doRequest("DELETE", "/v1/sso/config", nil, nil)
}

// ---------- Budget ----------

// BudgetAllocation represents a Grantex budget allocation resource.
//
// The API stores budgets as NUMERIC(18,4) and serialises them as JSON strings
// (e.g. "50.0000"). json.Number accepts both a JSON string and a JSON number,
// so decoding works regardless of which form the server emits.
type BudgetAllocation struct {
	ID              string      `json:"id"`
	GrantID         string      `json:"grantId"`
	InitialBudget   json.Number `json:"initialBudget"`
	RemainingBudget json.Number `json:"remainingBudget"`
	Currency        string      `json:"currency"`
	CreatedAt       string      `json:"createdAt"`
}

// InitialBudgetFloat returns InitialBudget parsed as a float64.
func (b *BudgetAllocation) InitialBudgetFloat() (float64, error) {
	return parseBudgetNumber("initialBudget", b.InitialBudget)
}

// RemainingBudgetFloat returns RemainingBudget parsed as a float64.
func (b *BudgetAllocation) RemainingBudgetFloat() (float64, error) {
	return parseBudgetNumber("remainingBudget", b.RemainingBudget)
}

func parseBudgetNumber(field string, n json.Number) (float64, error) {
	if n == "" {
		return 0, nil
	}
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil {
		return 0, fmt.Errorf("invalid %s %q: %w", field, string(n), err)
	}
	return f, nil
}

// CreateBudgetAllocationRequest is the request body for creating a budget allocation.
type CreateBudgetAllocationRequest struct {
	GrantID       string  `json:"grantId"`
	InitialBudget float64 `json:"initialBudget"`
	Currency      string  `json:"currency,omitempty"`
}

// CreateBudgetAllocation allocates a budget to a grant.
func (c *Client) CreateBudgetAllocation(req CreateBudgetAllocationRequest) (*BudgetAllocation, error) {
	var alloc BudgetAllocation
	err := c.doRequest("POST", "/v1/budget/allocate", req, &alloc)
	if err != nil {
		return nil, err
	}
	return &alloc, nil
}

// GetBudgetBalance retrieves the budget balance for a grant.
func (c *Client) GetBudgetBalance(grantID string) (*BudgetAllocation, error) {
	var alloc BudgetAllocation
	err := c.doRequest("GET", fmt.Sprintf("/v1/budget/balance/%s", url.PathEscape(grantID)), nil, &alloc)
	if err != nil {
		return nil, err
	}
	return &alloc, nil
}

// ---------- Grants (Data Source) ----------

// Grant represents a Grantex grant as returned by GET /v1/grants.
type Grant struct {
	GrantID     string   `json:"grantId"`
	AgentID     string   `json:"agentId"`
	PrincipalID string   `json:"principalId"`
	Scopes      []string `json:"scopes"`
	Status      string   `json:"status"`
	ExpiresAt   string   `json:"expiresAt"`
	IssuedAt    string   `json:"issuedAt"`
}

// ListGrantsResponse is the response from listing grants.
type ListGrantsResponse struct {
	Grants []Grant `json:"grants"`
}

// ListGrants lists grants with optional filters.
func (c *Client) ListGrants(agentID, principalID, status string) ([]Grant, error) {
	query := url.Values{}
	if agentID != "" {
		query.Set("agentId", agentID)
	}
	if principalID != "" {
		query.Set("principalId", principalID)
	}
	if status != "" {
		query.Set("status", status)
	}

	path := "/v1/grants"
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}

	var resp ListGrantsResponse
	err := c.doRequest("GET", path, nil, &resp)
	if err != nil {
		return nil, err
	}
	return resp.Grants, nil
}

// ---------- Internal ----------

// APIError represents an error response from the Grantex API.
// Routes emit {message, code, requestId} (see auth-service plugins/errors.ts).
type APIError struct {
	StatusCode int
	Message    string `json:"message"`
	Code       string `json:"code"`
	RequestID  string `json:"requestId,omitempty"`
}

func (e *APIError) Error() string {
	return fmt.Sprintf("grantex API error (status %d, code %s): %s", e.StatusCode, e.Code, e.Message)
}

// IsNotFound reports whether err is an APIError with HTTP status 404.
func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusNotFound
}

func (c *Client) doRequest(method, path string, body interface{}, result interface{}) error {
	endpoint := c.BaseURL + path

	var reqBody io.Reader
	if body != nil {
		jsonBytes, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonBytes)
	}

	req, err := http.NewRequest(method, endpoint, reqBody)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "terraform-provider-grantex")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		apiErr := &APIError{StatusCode: resp.StatusCode}
		_ = json.Unmarshal(respBody, apiErr)
		if apiErr.Message == "" {
			apiErr.Message = string(respBody)
		}
		return apiErr
	}

	// For 204 No Content responses, skip unmarshalling.
	if resp.StatusCode == 204 || result == nil {
		return nil
	}

	if err := json.Unmarshal(respBody, result); err != nil {
		return fmt.Errorf("failed to unmarshal response: %w", err)
	}

	return nil
}
