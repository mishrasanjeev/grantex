package grantex

// --- Signup ---

// SignupParams are the parameters for developer registration.
type SignupParams struct {
	Name  string `json:"name"`
	Email string `json:"email,omitempty"`
}

// SignupResponse is returned from Signup.
type SignupResponse struct {
	DeveloperID string  `json:"developerId"`
	APIKey      string  `json:"apiKey"`
	Name        string  `json:"name"`
	Email       *string `json:"email"`
	Mode        string  `json:"mode"`
	CreatedAt   string  `json:"createdAt"`
}

// RotateKeyResponse is returned from RotateKey.
type RotateKeyResponse struct {
	APIKey    string `json:"apiKey"`
	RotatedAt string `json:"rotatedAt"`
}

// --- Agents ---

// Agent represents a registered agent.
type Agent struct {
	ID          string   `json:"id"`
	DID         string   `json:"did"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Scopes      []string `json:"scopes"`
	Status      string   `json:"status"`
	DeveloperID string   `json:"developerId"`
	CreatedAt   string   `json:"createdAt"`
	UpdatedAt   string   `json:"updatedAt"`
}

// RegisterAgentParams are the parameters for registering an agent.
type RegisterAgentParams struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Scopes      []string `json:"scopes"`
}

// UpdateAgentParams are the parameters for updating an agent.
type UpdateAgentParams struct {
	Name        *string  `json:"name,omitempty"`
	Description *string  `json:"description,omitempty"`
	Scopes      []string `json:"scopes,omitempty"`
}

// ListAgentsResponse is the response from listing agents.
type ListAgentsResponse struct {
	Agents   []Agent `json:"agents"`
	Total    int     `json:"total"`
	Page     int     `json:"page"`
	PageSize int     `json:"pageSize"`
}

// --- Authorization ---

// AuthorizeParams are the parameters for creating an authorization request.
type AuthorizeParams struct {
	AgentID             string   `json:"agentId"`
	PrincipalID         string   `json:"principalId"`
	Scopes              []string `json:"scopes"`
	ExpiresIn           string   `json:"expiresIn,omitempty"`
	RedirectURI         string   `json:"redirectUri,omitempty"`
	CodeChallenge       string   `json:"codeChallenge,omitempty"`
	CodeChallengeMethod string   `json:"codeChallengeMethod,omitempty"`
}

// AuthorizationRequest is the response from creating an authorization request.
type AuthorizationRequest struct {
	AuthRequestID string   `json:"authRequestId"`
	ConsentURL    string   `json:"consentUrl"`
	AgentID       string   `json:"agentId"`
	PrincipalID   string   `json:"principalId"`
	Scopes        []string `json:"scopes"`
	ExpiresIn     string   `json:"expiresIn"`
	ExpiresAt     string   `json:"expiresAt"`
	Status        string   `json:"status"`
	CreatedAt     string   `json:"createdAt"`
}

// --- Tokens ---

// ExchangeTokenParams are the parameters for exchanging an authorization code.
type ExchangeTokenParams struct {
	Code         string `json:"code"`
	AgentID      string `json:"agentId"`
	CodeVerifier string `json:"codeVerifier,omitempty"`
}

// RefreshTokenParams are the parameters for refreshing a token.
type RefreshTokenParams struct {
	RefreshToken string `json:"refreshToken"`
	AgentID      string `json:"agentId"`
}

// ExchangeTokenResponse is the response from token exchange or refresh.
type ExchangeTokenResponse struct {
	GrantToken   string   `json:"grantToken"`
	ExpiresAt    string   `json:"expiresAt"`
	Scopes       []string `json:"scopes"`
	RefreshToken string   `json:"refreshToken"`
	GrantID      string   `json:"grantId"`
}

// VerifyTokenResponse is the response from online token verification.
type VerifyTokenResponse struct {
	Valid     bool     `json:"valid"`
	GrantID   *string  `json:"grantId,omitempty"`
	Scopes    []string `json:"scopes,omitempty"`
	Principal *string  `json:"principal,omitempty"`
	Agent     *string  `json:"agent,omitempty"`
	ExpiresAt *string  `json:"expiresAt,omitempty"`
}

// --- Grants ---

// Grant represents an authorization grant.
type Grant struct {
	ID          string   `json:"grantId"`
	AgentID     string   `json:"agentId"`
	AgentDID    string   `json:"agentDid"`
	PrincipalID string   `json:"principalId"`
	DeveloperID string   `json:"developerId"`
	Scopes      []string `json:"scopes"`
	Status      string   `json:"status"`
	IssuedAt    string   `json:"issuedAt"`
	ExpiresAt   string   `json:"expiresAt"`
	RevokedAt   *string  `json:"revokedAt,omitempty"`
}

// ListGrantsParams are the parameters for listing grants.
type ListGrantsParams struct {
	AgentID     string `json:"agentId,omitempty"`
	PrincipalID string `json:"principalId,omitempty"`
	Status      string `json:"status,omitempty"`
	Page        int    `json:"page,omitempty"`
	PageSize    int    `json:"pageSize,omitempty"`
}

// ListGrantsResponse is the response from listing grants.
type ListGrantsResponse struct {
	Grants   []Grant `json:"grants"`
	Total    int     `json:"total"`
	Page     int     `json:"page"`
	PageSize int     `json:"pageSize"`
}

// DelegateParams are the parameters for grant delegation.
type DelegateParams struct {
	ParentGrantToken string   `json:"parentGrantToken"`
	SubAgentID       string   `json:"subAgentId"`
	Scopes           []string `json:"scopes"`
	ExpiresIn        string   `json:"expiresIn,omitempty"`
}

// DelegateResponse is the response from grant delegation.
type DelegateResponse struct {
	GrantToken string   `json:"grantToken"`
	ExpiresAt  string   `json:"expiresAt"`
	Scopes     []string `json:"scopes"`
	GrantID    string   `json:"grantId"`
}

// VerifiedGrant represents a verified JWT grant token's claims.
type VerifiedGrant struct {
	TokenID         string   `json:"tokenId"`
	GrantID         string   `json:"grantId"`
	PrincipalID     string   `json:"principalId"`
	AgentDID        string   `json:"agentDid"`
	DeveloperID     string   `json:"developerId"`
	Scopes          []string `json:"scopes"`
	IssuedAt        int64    `json:"issuedAt"`
	ExpiresAt       int64    `json:"expiresAt"`
	ParentAgentDID  *string  `json:"parentAgentDid,omitempty"`
	ParentGrantID   *string  `json:"parentGrantId,omitempty"`
	DelegationDepth *int     `json:"delegationDepth,omitempty"`
}

// --- Audit ---

// LogAuditParams are the parameters for logging an audit entry.
type LogAuditParams struct {
	AgentID  string                 `json:"agentId"`
	GrantID  string                 `json:"grantId"`
	Action   string                 `json:"action"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
	Status   string                 `json:"status,omitempty"`
}

// AuditEntry represents an audit log entry.
type AuditEntry struct {
	EntryID     string                 `json:"entryId"`
	AgentID     string                 `json:"agentId"`
	AgentDID    string                 `json:"agentDid"`
	GrantID     string                 `json:"grantId"`
	PrincipalID string                 `json:"principalId"`
	Action      string                 `json:"action"`
	Metadata    map[string]interface{} `json:"metadata"`
	Hash        string                 `json:"hash"`
	PrevHash    *string                `json:"prevHash"`
	Timestamp   string                 `json:"timestamp"`
	Status      string                 `json:"status"`
}

// ListAuditParams are the parameters for listing audit entries.
type ListAuditParams struct {
	AgentID     string `json:"agentId,omitempty"`
	GrantID     string `json:"grantId,omitempty"`
	PrincipalID string `json:"principalId,omitempty"`
	Action      string `json:"action,omitempty"`
	Since       string `json:"since,omitempty"`
	Until       string `json:"until,omitempty"`
	Page        int    `json:"page,omitempty"`
	PageSize    int    `json:"pageSize,omitempty"`
}

// ListAuditResponse is the response from listing audit entries.
type ListAuditResponse struct {
	Entries  []AuditEntry `json:"entries"`
	Total    int          `json:"total"`
	Page     int          `json:"page"`
	PageSize int          `json:"pageSize"`
}

// --- Webhooks ---

// CreateWebhookParams are the parameters for creating a webhook.
type CreateWebhookParams struct {
	URL    string   `json:"url"`
	Events []string `json:"events"`
}

// WebhookEndpoint represents a webhook endpoint.
type WebhookEndpoint struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	CreatedAt string   `json:"createdAt"`
}

// WebhookEndpointWithSecret is a webhook endpoint that includes the signing secret.
type WebhookEndpointWithSecret struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	CreatedAt string   `json:"createdAt"`
	Secret    string   `json:"secret"`
}

// ListWebhooksResponse is the response from listing webhooks.
type ListWebhooksResponse struct {
	Webhooks []WebhookEndpoint `json:"webhooks"`
}

// --- Billing ---

// SubscriptionStatus represents the current subscription.
type SubscriptionStatus struct {
	Plan             string  `json:"plan"`
	Status           string  `json:"status"`
	CurrentPeriodEnd *string `json:"currentPeriodEnd"`
}

// CreateCheckoutParams are the parameters for creating a checkout session.
type CreateCheckoutParams struct {
	Plan       string `json:"plan"`
	SuccessURL string `json:"successUrl"`
	CancelURL  string `json:"cancelUrl"`
}

// CheckoutResponse is the response from creating a checkout.
type CheckoutResponse struct {
	CheckoutURL string `json:"checkoutUrl"`
}

// CreatePortalParams are the parameters for creating a billing portal session.
type CreatePortalParams struct {
	ReturnURL string `json:"returnUrl"`
}

// PortalResponse is the response from creating a portal session.
type PortalResponse struct {
	PortalURL string `json:"portalUrl"`
}

// --- Policies ---

// Policy represents an access policy.
type Policy struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Effect        string   `json:"effect"`
	Priority      int      `json:"priority"`
	AgentID       *string  `json:"agentId"`
	PrincipalID   *string  `json:"principalId"`
	Scopes        []string `json:"scopes"`
	TimeOfDayStart *string `json:"timeOfDayStart"`
	TimeOfDayEnd   *string `json:"timeOfDayEnd"`
	CreatedAt     string   `json:"createdAt"`
	UpdatedAt     string   `json:"updatedAt"`
}

// CreatePolicyParams are the parameters for creating a policy.
type CreatePolicyParams struct {
	Name           string   `json:"name"`
	Effect         string   `json:"effect"`
	Priority       *int     `json:"priority,omitempty"`
	AgentID        string   `json:"agentId,omitempty"`
	PrincipalID    string   `json:"principalId,omitempty"`
	Scopes         []string `json:"scopes,omitempty"`
	TimeOfDayStart string   `json:"timeOfDayStart,omitempty"`
	TimeOfDayEnd   string   `json:"timeOfDayEnd,omitempty"`
}

// UpdatePolicyParams are the parameters for updating a policy.
type UpdatePolicyParams struct {
	Name           *string  `json:"name,omitempty"`
	Effect         *string  `json:"effect,omitempty"`
	Priority       *int     `json:"priority,omitempty"`
	AgentID        *string  `json:"agentId,omitempty"`
	PrincipalID    *string  `json:"principalId,omitempty"`
	Scopes         []string `json:"scopes,omitempty"`
	TimeOfDayStart *string  `json:"timeOfDayStart,omitempty"`
	TimeOfDayEnd   *string  `json:"timeOfDayEnd,omitempty"`
}

// ListPoliciesResponse is the response from listing policies.
type ListPoliciesResponse struct {
	Policies []Policy `json:"policies"`
	Total    int      `json:"total"`
}

// --- Compliance ---

// ComplianceSummaryParams are the parameters for getting a compliance summary.
type ComplianceSummaryParams struct {
	Since string `json:"since,omitempty"`
	Until string `json:"until,omitempty"`
}

// ComplianceSummary is the compliance overview.
type ComplianceSummary struct {
	GeneratedAt  string                       `json:"generatedAt"`
	Since        *string                      `json:"since,omitempty"`
	Until        *string                      `json:"until,omitempty"`
	Agents       ComplianceSummaryAgents       `json:"agents"`
	Grants       ComplianceSummaryGrants       `json:"grants"`
	AuditEntries ComplianceSummaryAuditEntries `json:"auditEntries"`
	Policies     ComplianceSummaryPolicies     `json:"policies"`
	Plan         string                       `json:"plan"`
}

// ComplianceSummaryAgents is agent stats in a compliance summary.
type ComplianceSummaryAgents struct {
	Total     int `json:"total"`
	Active    int `json:"active"`
	Suspended int `json:"suspended"`
	Revoked   int `json:"revoked"`
}

// ComplianceSummaryGrants is grant stats in a compliance summary.
type ComplianceSummaryGrants struct {
	Total   int `json:"total"`
	Active  int `json:"active"`
	Revoked int `json:"revoked"`
	Expired int `json:"expired"`
}

// ComplianceSummaryAuditEntries is audit stats in a compliance summary.
type ComplianceSummaryAuditEntries struct {
	Total   int `json:"total"`
	Success int `json:"success"`
	Failure int `json:"failure"`
	Blocked int `json:"blocked"`
}

// ComplianceSummaryPolicies is policy stats in a compliance summary.
type ComplianceSummaryPolicies struct {
	Total int `json:"total"`
}

// ComplianceExportGrantsParams are the parameters for exporting grants.
type ComplianceExportGrantsParams struct {
	Since  string `json:"since,omitempty"`
	Until  string `json:"until,omitempty"`
	Status string `json:"status,omitempty"`
}

// ComplianceGrantsExport is the exported grants data.
type ComplianceGrantsExport struct {
	GeneratedAt string  `json:"generatedAt"`
	Total       int     `json:"total"`
	Grants      []Grant `json:"grants"`
}

// ComplianceExportAuditParams are the parameters for exporting audit entries.
type ComplianceExportAuditParams struct {
	Since   string `json:"since,omitempty"`
	Until   string `json:"until,omitempty"`
	AgentID string `json:"agentId,omitempty"`
	Status  string `json:"status,omitempty"`
}

// ComplianceAuditExport is the exported audit data.
type ComplianceAuditExport struct {
	GeneratedAt string       `json:"generatedAt"`
	Total       int          `json:"total"`
	Entries     []AuditEntry `json:"entries"`
}

// EvidencePackParams are the parameters for generating an evidence pack.
type EvidencePackParams struct {
	Since     string `json:"since,omitempty"`
	Until     string `json:"until,omitempty"`
	Framework string `json:"framework,omitempty"`
}

// EvidencePack is a compliance evidence package.
type EvidencePack struct {
	Meta           EvidencePackMeta    `json:"meta"`
	Summary        ComplianceSummary   `json:"summary"`
	Grants         []Grant             `json:"grants"`
	AuditEntries   []AuditEntry        `json:"auditEntries"`
	Policies       []Policy            `json:"policies"`
	ChainIntegrity ChainIntegrity      `json:"chainIntegrity"`
}

// EvidencePackMeta is metadata for an evidence pack.
type EvidencePackMeta struct {
	SchemaVersion string  `json:"schemaVersion"`
	GeneratedAt   string  `json:"generatedAt"`
	Since         *string `json:"since,omitempty"`
	Until         *string `json:"until,omitempty"`
	Framework     string  `json:"framework"`
}

// ChainIntegrity represents audit chain integrity check results.
type ChainIntegrity struct {
	Valid          bool    `json:"valid"`
	CheckedEntries int    `json:"checkedEntries"`
	FirstBrokenAt  *string `json:"firstBrokenAt"`
}

// --- Anomalies ---

// Anomaly represents a detected anomaly.
type Anomaly struct {
	ID             string                 `json:"id"`
	Type           string                 `json:"type"`
	Severity       string                 `json:"severity"`
	AgentID        *string                `json:"agentId"`
	PrincipalID    *string                `json:"principalId"`
	Description    string                 `json:"description"`
	Metadata       map[string]interface{} `json:"metadata"`
	DetectedAt     string                 `json:"detectedAt"`
	AcknowledgedAt *string                `json:"acknowledgedAt"`
}

// DetectAnomaliesResponse is the response from anomaly detection.
type DetectAnomaliesResponse struct {
	DetectedAt string    `json:"detectedAt"`
	Total      int       `json:"total"`
	Anomalies  []Anomaly `json:"anomalies"`
}

// ListAnomaliesParams are the parameters for listing anomalies.
type ListAnomaliesParams struct {
	Unacknowledged *bool `json:"unacknowledged,omitempty"`
}

// ListAnomaliesResponse is the response from listing anomalies.
type ListAnomaliesResponse struct {
	Anomalies []Anomaly `json:"anomalies"`
	Total     int       `json:"total"`
}

// --- SCIM ---

// ScimEmail represents an email in SCIM format.
type ScimEmail struct {
	Value   string `json:"value"`
	Primary bool   `json:"primary,omitempty"`
}

// ScimUserMeta is SCIM user metadata.
type ScimUserMeta struct {
	ResourceType string `json:"resourceType"`
	Created      string `json:"created"`
	LastModified string `json:"lastModified"`
}

// ScimUser represents a SCIM-provisioned user.
type ScimUser struct {
	ID          string       `json:"id"`
	ExternalID  *string      `json:"externalId,omitempty"`
	UserName    string       `json:"userName"`
	DisplayName *string      `json:"displayName,omitempty"`
	Active      bool         `json:"active"`
	Emails      []ScimEmail  `json:"emails"`
	Meta        ScimUserMeta `json:"meta"`
}

// CreateScimUserParams are the parameters for creating a SCIM user.
type CreateScimUserParams struct {
	UserName    string      `json:"userName"`
	DisplayName string      `json:"displayName,omitempty"`
	ExternalID  string      `json:"externalId,omitempty"`
	Emails      []ScimEmail `json:"emails,omitempty"`
	Active      *bool       `json:"active,omitempty"`
}

// ScimOperation represents a SCIM PATCH operation.
type ScimOperation struct {
	Op    string      `json:"op"`
	Path  string      `json:"path,omitempty"`
	Value interface{} `json:"value,omitempty"`
}

// ListScimUsersParams are the parameters for listing SCIM users.
type ListScimUsersParams struct {
	StartIndex int `json:"startIndex,omitempty"`
	Count      int `json:"count,omitempty"`
}

// ScimListResponse is the SCIM list response.
type ScimListResponse struct {
	TotalResults int        `json:"totalResults"`
	StartIndex   int        `json:"startIndex"`
	ItemsPerPage int        `json:"itemsPerPage"`
	Resources    []ScimUser `json:"Resources"`
}

// ScimToken represents a SCIM provisioning token.
type ScimToken struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	CreatedAt  string  `json:"createdAt"`
	LastUsedAt *string `json:"lastUsedAt"`
}

// ScimTokenWithSecret is a SCIM token that includes the secret value.
type ScimTokenWithSecret struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	CreatedAt  string  `json:"createdAt"`
	LastUsedAt *string `json:"lastUsedAt"`
	Token      string  `json:"token"`
}

// CreateScimTokenParams are the parameters for creating a SCIM token.
type CreateScimTokenParams struct {
	Label string `json:"label"`
}

// ListScimTokensResponse is the response from listing SCIM tokens.
type ListScimTokensResponse struct {
	Tokens []ScimToken `json:"tokens"`
}

// --- SSO ---

// SsoConfig represents an SSO configuration.
type SsoConfig struct {
	IssuerURL   string `json:"issuerUrl"`
	ClientID    string `json:"clientId"`
	RedirectURI string `json:"redirectUri"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

// CreateSsoConfigParams are the parameters for creating an SSO configuration.
type CreateSsoConfigParams struct {
	IssuerURL    string `json:"issuerUrl"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	RedirectURI  string `json:"redirectUri"`
}

// SsoLoginResponse is the response from getting an SSO login URL.
type SsoLoginResponse struct {
	AuthorizeURL string `json:"authorizeUrl"`
}

// SsoCallbackResponse is the response from handling an SSO callback.
type SsoCallbackResponse struct {
	Email       *string `json:"email"`
	Name        *string `json:"name"`
	Sub         *string `json:"sub"`
	DeveloperID string  `json:"developerId"`
}

// --- Principal Sessions ---

// CreatePrincipalSessionParams are the parameters for creating a principal session.
type CreatePrincipalSessionParams struct {
	PrincipalID string `json:"principalId"`
	ExpiresIn   string `json:"expiresIn,omitempty"`
}

// PrincipalSessionResponse is the response from creating a principal session.
type PrincipalSessionResponse struct {
	SessionToken string `json:"sessionToken"`
	DashboardURL string `json:"dashboardUrl"`
	ExpiresAt    string `json:"expiresAt"`
}
