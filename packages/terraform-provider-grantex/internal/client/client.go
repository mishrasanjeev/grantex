package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
type UpdateAgentRequest struct {
	Name        string   `json:"name,omitempty"`
	Description string   `json:"description,omitempty"`
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
	err := c.doRequest("GET", fmt.Sprintf("/v1/agents/%s", agentID), nil, &agent)
	if err != nil {
		return nil, err
	}
	return &agent, nil
}

// UpdateAgent updates an existing agent.
func (c *Client) UpdateAgent(agentID string, req UpdateAgentRequest) (*Agent, error) {
	var agent Agent
	err := c.doRequest("PATCH", fmt.Sprintf("/v1/agents/%s", agentID), req, &agent)
	if err != nil {
		return nil, err
	}
	return &agent, nil
}

// DeleteAgent deletes an agent by ID.
func (c *Client) DeleteAgent(agentID string) error {
	return c.doRequest("DELETE", fmt.Sprintf("/v1/agents/%s", agentID), nil, nil)
}

// ---------- Policy ----------

// Policy represents a Grantex policy resource.
type Policy struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Effect         string   `json:"effect"`
	Priority       int64    `json:"priority,omitempty"`
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
type UpdatePolicyRequest struct {
	Name           string   `json:"name,omitempty"`
	Effect         string   `json:"effect,omitempty"`
	Priority       int64    `json:"priority,omitempty"`
	AgentID        string   `json:"agentId,omitempty"`
	PrincipalID    string   `json:"principalId,omitempty"`
	Scopes         []string `json:"scopes,omitempty"`
	TimeOfDayStart string   `json:"timeOfDayStart,omitempty"`
	TimeOfDayEnd   string   `json:"timeOfDayEnd,omitempty"`
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
	err := c.doRequest("GET", fmt.Sprintf("/v1/policies/%s", id), nil, &policy)
	if err != nil {
		return nil, err
	}
	return &policy, nil
}

// UpdatePolicy updates an existing policy.
func (c *Client) UpdatePolicy(id string, req UpdatePolicyRequest) (*Policy, error) {
	var policy Policy
	err := c.doRequest("PATCH", fmt.Sprintf("/v1/policies/%s", id), req, &policy)
	if err != nil {
		return nil, err
	}
	return &policy, nil
}

// DeletePolicy deletes a policy by ID.
func (c *Client) DeletePolicy(id string) error {
	return c.doRequest("DELETE", fmt.Sprintf("/v1/policies/%s", id), nil, nil)
}

// ---------- Webhook ----------

// Webhook represents a Grantex webhook resource.
type Webhook struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	Secret    string   `json:"secret,omitempty"`
	CreatedAt string   `json:"createdAt"`
}

// CreateWebhookRequest is the request body for creating a webhook.
type CreateWebhookRequest struct {
	URL    string   `json:"url"`
	Events []string `json:"events"`
	Secret string   `json:"secret,omitempty"`
}

// UpdateWebhookRequest is the request body for updating a webhook.
type UpdateWebhookRequest struct {
	URL    string   `json:"url,omitempty"`
	Events []string `json:"events,omitempty"`
	Secret string   `json:"secret,omitempty"`
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

// GetWebhook retrieves a webhook by ID.
func (c *Client) GetWebhook(id string) (*Webhook, error) {
	var webhook Webhook
	err := c.doRequest("GET", fmt.Sprintf("/v1/webhooks/%s", id), nil, &webhook)
	if err != nil {
		return nil, err
	}
	return &webhook, nil
}

// UpdateWebhook updates an existing webhook.
func (c *Client) UpdateWebhook(id string, req UpdateWebhookRequest) (*Webhook, error) {
	var webhook Webhook
	err := c.doRequest("PATCH", fmt.Sprintf("/v1/webhooks/%s", id), req, &webhook)
	if err != nil {
		return nil, err
	}
	return &webhook, nil
}

// DeleteWebhook deletes a webhook by ID.
func (c *Client) DeleteWebhook(id string) error {
	return c.doRequest("DELETE", fmt.Sprintf("/v1/webhooks/%s", id), nil, nil)
}

// ---------- SSO Config ----------

// SSOConfig represents a Grantex SSO configuration resource.
type SSOConfig struct {
	ID           string `json:"id"`
	Provider     string `json:"provider"`
	Domain       string `json:"domain"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret,omitempty"`
	MetadataURL  string `json:"metadataUrl,omitempty"`
	CreatedAt    string `json:"createdAt"`
}

// UpsertSSOConfigRequest is the request body for creating/updating an SSO config.
type UpsertSSOConfigRequest struct {
	Provider     string `json:"provider"`
	Domain       string `json:"domain"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	MetadataURL  string `json:"metadataUrl,omitempty"`
}

// UpsertSSOConfig creates or updates the SSO configuration.
func (c *Client) UpsertSSOConfig(req UpsertSSOConfigRequest) (*SSOConfig, error) {
	var config SSOConfig
	err := c.doRequest("PUT", "/v1/sso/config", req, &config)
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
type BudgetAllocation struct {
	ID              string  `json:"id"`
	GrantID         string  `json:"grantId"`
	InitialBudget   float64 `json:"initialBudget"`
	RemainingBudget float64 `json:"remainingBudget"`
	Currency        string  `json:"currency"`
	CreatedAt       string  `json:"createdAt"`
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
	err := c.doRequest("GET", fmt.Sprintf("/v1/budget/balance/%s", grantID), nil, &alloc)
	if err != nil {
		return nil, err
	}
	return &alloc, nil
}

// ---------- Grants (Data Source) ----------

// Grant represents a Grantex grant.
type Grant struct {
	GrantID     string   `json:"grantId"`
	AgentID     string   `json:"agentId"`
	PrincipalID string   `json:"principalId"`
	Scopes      []string `json:"scopes"`
	Status      string   `json:"status"`
	ExpiresAt   string   `json:"expiresAt"`
	CreatedAt   string   `json:"createdAt"`
}

// ListGrantsResponse is the response from listing grants.
type ListGrantsResponse struct {
	Grants []Grant `json:"grants"`
}

// ListGrants lists grants with optional filters.
func (c *Client) ListGrants(agentID, principalID, status string) ([]Grant, error) {
	path := "/v1/grants?"
	params := []string{}
	if agentID != "" {
		params = append(params, fmt.Sprintf("agentId=%s", agentID))
	}
	if principalID != "" {
		params = append(params, fmt.Sprintf("principalId=%s", principalID))
	}
	if status != "" {
		params = append(params, fmt.Sprintf("status=%s", status))
	}
	for i, p := range params {
		if i > 0 {
			path += "&"
		}
		path += p
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
type APIError struct {
	StatusCode int
	Message    string `json:"error"`
	Code       string `json:"code"`
}

func (e *APIError) Error() string {
	return fmt.Sprintf("grantex API error (status %d, code %s): %s", e.StatusCode, e.Code, e.Message)
}

func (c *Client) doRequest(method, path string, body interface{}, result interface{}) error {
	url := c.BaseURL + path

	var reqBody io.Reader
	if body != nil {
		jsonBytes, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonBytes)
	}

	req, err := http.NewRequest(method, url, reqBody)
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
