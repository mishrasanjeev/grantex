package grantex

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type WalletRecord map[string]any

type PrepaidWallet struct {
	WalletID              string       `json:"walletId"`
	PrincipalID           string       `json:"principalId"`
	Name                  string       `json:"name"`
	CustodyMode           string       `json:"custodyMode"`
	Provider              *string      `json:"provider"`
	ProviderWalletID      *string      `json:"providerWalletId"`
	WalletAddress         *string      `json:"walletAddress"`
	Network               string       `json:"network"`
	Asset                 string       `json:"asset"`
	Decimals              int          `json:"decimals"`
	AvailableAmount       string       `json:"availableAmount"`
	ReservedAmount        string       `json:"reservedAmount"`
	LowBalanceThreshold   string       `json:"lowBalanceThreshold"`
	MaxBalance            *string      `json:"maxBalance"`
	MaxReloadAmount       *string      `json:"maxReloadAmount"`
	ReloadCumulativeLimit *string      `json:"reloadCumulativeLimit"`
	ReloadPeriodSeconds   *int         `json:"reloadPeriodSeconds"`
	ReloadCountLimit      *int         `json:"reloadCountLimit"`
	Status                string       `json:"status"`
	BlockedAt             *string      `json:"blockedAt"`
	BlockedReason         *string      `json:"blockedReason"`
	Metadata              WalletRecord `json:"metadata"`
	CreatedAt             string       `json:"createdAt"`
	UpdatedAt             string       `json:"updatedAt"`
}

type CreatePrepaidWalletParams struct {
	Name                  string       `json:"name"`
	CustodyMode           string       `json:"custodyMode"`
	Provider              string       `json:"provider,omitempty"`
	ProviderWalletID      string       `json:"providerWalletId,omitempty"`
	WalletAddress         string       `json:"walletAddress,omitempty"`
	Network               string       `json:"network"`
	Asset                 string       `json:"asset"`
	Decimals              *int         `json:"decimals,omitempty"`
	LowBalanceThreshold   string       `json:"lowBalanceThreshold,omitempty"`
	MaxBalance            string       `json:"maxBalance,omitempty"`
	MaxReloadAmount       string       `json:"maxReloadAmount,omitempty"`
	ReloadCumulativeLimit string       `json:"reloadCumulativeLimit,omitempty"`
	ReloadPeriodSeconds   *int         `json:"reloadPeriodSeconds,omitempty"`
	ReloadCountLimit      *int         `json:"reloadCountLimit,omitempty"`
	Metadata              WalletRecord `json:"metadata,omitempty"`
}

type AssignPrepaidWalletParams struct {
	AgentID                 string   `json:"agentId"`
	PerTransactionLimit     string   `json:"perTransactionLimit"`
	CumulativeLimit         string   `json:"cumulativeLimit"`
	CumulativePeriodSeconds int      `json:"cumulativePeriodSeconds"`
	AllowedRecipients       []string `json:"allowedRecipients,omitempty"`
	AllowedScopes           []string `json:"allowedScopes,omitempty"`
	AllowedResourceOrigins  []string `json:"allowedResourceOrigins,omitempty"`
	AllowAnyRecipient       bool     `json:"allowAnyRecipient,omitempty"`
	AllowAnyScope           bool     `json:"allowAnyScope,omitempty"`
	AllowAnyResource        bool     `json:"allowAnyResource,omitempty"`
	BudgetGroup             string   `json:"budgetGroup,omitempty"`
	ValidUntil              string   `json:"validUntil,omitempty"`
}

type WalletAssignment struct {
	AssignmentID            string   `json:"assignmentId"`
	WalletID                string   `json:"walletId"`
	AgentID                 string   `json:"agentId"`
	PrincipalID             string   `json:"principalId"`
	Status                  string   `json:"status"`
	PerTransactionLimit     string   `json:"perTransactionLimit"`
	CumulativeLimit         string   `json:"cumulativeLimit"`
	CumulativePeriodSeconds int      `json:"cumulativePeriodSeconds"`
	AllowedRecipients       []string `json:"allowedRecipients"`
	AllowedScopes           []string `json:"allowedScopes"`
	AllowedResourceOrigins  []string `json:"allowedResourceOrigins"`
	AllowAnyRecipient       bool     `json:"allowAnyRecipient"`
	AllowAnyScope           bool     `json:"allowAnyScope"`
	AllowAnyResource        bool     `json:"allowAnyResource"`
	BudgetGroup             *string  `json:"budgetGroup"`
	ValidFrom               string   `json:"validFrom"`
	ValidUntil              *string  `json:"validUntil"`
	BlockedAt               *string  `json:"blockedAt"`
	BlockedReason           *string  `json:"blockedReason"`
	CreatedAt               string   `json:"createdAt"`
	UpdatedAt               string   `json:"updatedAt"`
}

type AssignedPrepaidWallet struct {
	WalletID                string   `json:"walletId"`
	Name                    string   `json:"name"`
	Network                 string   `json:"network"`
	Asset                   string   `json:"asset"`
	Decimals                int      `json:"decimals"`
	AvailableAmount         string   `json:"availableAmount"`
	ReservedAmount          string   `json:"reservedAmount"`
	LowBalanceThreshold     string   `json:"lowBalanceThreshold"`
	Status                  string   `json:"status"`
	BlockedAt               *string  `json:"blockedAt"`
	BlockedReason           *string  `json:"blockedReason"`
	AssignmentID            string   `json:"assignmentId"`
	AssignmentStatus        string   `json:"assignmentStatus"`
	PerTransactionLimit     string   `json:"perTransactionLimit"`
	CumulativeLimit         string   `json:"cumulativeLimit"`
	CumulativePeriodSeconds int      `json:"cumulativePeriodSeconds"`
	AllowedRecipients       []string `json:"allowedRecipients"`
	AllowedScopes           []string `json:"allowedScopes"`
	AllowedResourceOrigins  []string `json:"allowedResourceOrigins"`
	AllowAnyRecipient       bool     `json:"allowAnyRecipient"`
	AllowAnyScope           bool     `json:"allowAnyScope"`
	AllowAnyResource        bool     `json:"allowAnyResource"`
	BudgetGroup             *string  `json:"budgetGroup"`
	ValidFrom               string   `json:"validFrom"`
	ValidUntil              *string  `json:"validUntil"`
	AllWalletsBlocked       bool     `json:"allWalletsBlocked"`
	CreatedAt               string   `json:"createdAt"`
	UpdatedAt               string   `json:"updatedAt"`
}

type WalletSpendPolicyParams struct {
	Name                    string   `json:"name"`
	Description             string   `json:"description,omitempty"`
	ScopeType               string   `json:"scopeType"`
	ScopeID                 string   `json:"scopeId,omitempty"`
	Effect                  string   `json:"effect"`
	OnExceed                string   `json:"onExceed,omitempty"`
	MaxAmount               string   `json:"maxAmount,omitempty"`
	MaxCount                *int     `json:"maxCount,omitempty"`
	WindowType              string   `json:"windowType,omitempty"`
	WindowSeconds           *int     `json:"windowSeconds,omitempty"`
	Recipients              []string `json:"recipients,omitempty"`
	ResourceOrigins         []string `json:"resourceOrigins,omitempty"`
	ActionScopes            []string `json:"actionScopes,omitempty"`
	Assets                  []string `json:"assets,omitempty"`
	Networks                []string `json:"networks,omitempty"`
	MerchantIDs             []string `json:"merchantIds,omitempty"`
	Purposes                []string `json:"purposes,omitempty"`
	ProjectIDs              []string `json:"projectIds,omitempty"`
	CostCenters             []string `json:"costCenters,omitempty"`
	RequireVerifiedMerchant bool     `json:"requireVerifiedMerchant,omitempty"`
	Priority                *int     `json:"priority,omitempty"`
	ValidFrom               string   `json:"validFrom,omitempty"`
	ValidUntil              string   `json:"validUntil,omitempty"`
}

type WalletSpendPolicy struct {
	WalletSpendPolicyParams
	PolicyID    string  `json:"policyId"`
	DeveloperID string  `json:"developerId"`
	PrincipalID *string `json:"principalId"`
	Status      string  `json:"status"`
	Version     int     `json:"version"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

type WalletPaymentApproval struct {
	ApprovalRequestID string   `json:"approvalRequestId"`
	WalletID          string   `json:"walletId"`
	AssignmentID      string   `json:"assignmentId"`
	AgentID           string   `json:"agentId"`
	Amount            string   `json:"amount"`
	Asset             string   `json:"asset"`
	Network           string   `json:"network"`
	Recipient         string   `json:"recipient"`
	Resource          string   `json:"resource"`
	Scope             string   `json:"scope"`
	MerchantID        *string  `json:"merchantId"`
	Purpose           *string  `json:"purpose"`
	ProjectID         *string  `json:"projectId"`
	CostCenter        *string  `json:"costCenter"`
	PolicyIDs         []string `json:"policyIds"`
	Status            string   `json:"status"`
	Reason            *string  `json:"reason"`
	ExpiresAt         string   `json:"expiresAt"`
	DecidedAt         *string  `json:"decidedAt"`
	ConsumedAt        *string  `json:"consumedAt"`
	ReservationID     *string  `json:"reservationId"`
	CreatedAt         string   `json:"createdAt"`
	UpdatedAt         string   `json:"updatedAt"`
}

type PrepaidAuthorizationRequest struct {
	WalletID          string `json:"walletId,omitempty"`
	Amount            string `json:"amount"`
	Asset             string `json:"asset"`
	Network           string `json:"network"`
	Recipient         string `json:"recipient"`
	Resource          string `json:"resource"`
	Scope             string `json:"scope"`
	MaxTimeoutSeconds int    `json:"maxTimeoutSeconds"`
	IdempotencyKey    string `json:"idempotencyKey"`
	ApprovalRequestID string `json:"approvalRequestId,omitempty"`
	MerchantID        string `json:"merchantId,omitempty"`
	Purpose           string `json:"purpose,omitempty"`
	ProjectID         string `json:"projectId,omitempty"`
	CostCenter        string `json:"costCenter,omitempty"`
}

type PrepaidAuthorizationResponse struct {
	Status              string   `json:"status,omitempty"`
	ApprovalRequestID   string   `json:"approvalRequestId,omitempty"`
	PolicyIDs           []string `json:"policyIds,omitempty"`
	Authorization       string   `json:"authorization,omitempty"`
	ReservationID       string   `json:"reservationId,omitempty"`
	WalletID            string   `json:"walletId"`
	AssignmentID        string   `json:"assignmentId"`
	Amount              string   `json:"amount,omitempty"`
	Asset               string   `json:"asset,omitempty"`
	Network             string   `json:"network,omitempty"`
	Recipient           string   `json:"recipient,omitempty"`
	ExpiresAt           string   `json:"expiresAt"`
	RemainingAvailable  string   `json:"remainingAvailable,omitempty"`
	RemainingCumulative string   `json:"remainingCumulative,omitempty"`
	PolicyDecisionID    *string  `json:"policyDecisionId,omitempty"`
}

type WalletReloadRequest struct {
	ReloadRequestID   string  `json:"reloadRequestId"`
	WalletID          string  `json:"walletId"`
	AssignmentID      *string `json:"assignmentId"`
	AgentID           *string `json:"agentId"`
	Amount            string  `json:"amount"`
	Reason            *string `json:"reason"`
	Status            string  `json:"status"`
	RequestedBy       string  `json:"requestedBy"`
	ExternalReference *string `json:"externalReference"`
	CreatedAt         string  `json:"createdAt"`
	DecidedAt         *string `json:"decidedAt"`
	FundedAt          *string `json:"fundedAt"`
}

type WalletSpendPoliciesService struct{ http *httpClient }

func (s *WalletSpendPoliciesService) Create(ctx context.Context, params WalletSpendPolicyParams) (*WalletSpendPolicy, error) {
	return unmarshal[WalletSpendPolicy](s.http.post(ctx, "/v1/prepaid-wallet-spend-policies", params))
}

func (s *WalletSpendPoliciesService) List(ctx context.Context) ([]WalletSpendPolicy, error) {
	var response struct {
		Policies []WalletSpendPolicy `json:"policies"`
	}
	data, err := s.http.get(ctx, "/v1/prepaid-wallet-spend-policies")
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, err
	}
	return response.Policies, nil
}

func (s *WalletSpendPoliciesService) SetStatus(ctx context.Context, policyID, status string) (*WalletSpendPolicy, error) {
	return unmarshal[WalletSpendPolicy](s.http.patch(ctx, "/v1/prepaid-wallet-spend-policies/"+url.PathEscape(policyID)+"/status", WalletRecord{"status": status}))
}

type PrincipalPrepaidWalletClient struct{ http *httpClient }

func NewPrincipalPrepaidWalletClient(sessionToken string, opts ...Option) (*PrincipalPrepaidWalletClient, error) {
	if strings.TrimSpace(sessionToken) == "" {
		return nil, errors.New("session token is required")
	}
	cfg := &clientConfig{baseURL: defaultBaseURL, timeout: defaultTimeout}
	for _, opt := range opts {
		opt(cfg)
	}
	hc := cfg.httpClient
	if hc == nil {
		hc = &http.Client{Timeout: cfg.timeout}
	}
	base, err := secureWalletURL(cfg.baseURL, false)
	if err != nil {
		return nil, err
	}
	return &PrincipalPrepaidWalletClient{http: &httpClient{baseURL: base, apiKey: strings.TrimSpace(sessionToken), client: hc, maxRetries: cfg.maxRetries, maxRetriesSet: cfg.maxRetriesSet}}, nil
}

func (c *PrincipalPrepaidWalletClient) Create(ctx context.Context, params CreatePrepaidWalletParams) (*PrepaidWallet, error) {
	return unmarshal[PrepaidWallet](c.http.post(ctx, "/v1/principal/prepaid-wallets", params))
}
func (c *PrincipalPrepaidWalletClient) List(ctx context.Context) ([]PrepaidWallet, error) {
	var response struct {
		Wallets []PrepaidWallet `json:"wallets"`
	}
	data, err := c.http.get(ctx, "/v1/principal/prepaid-wallets")
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, err
	}
	return response.Wallets, nil
}
func (c *PrincipalPrepaidWalletClient) Activity(ctx context.Context, walletID string) (WalletRecord, error) {
	return unmarshalValue[WalletRecord](c.http.get(ctx, "/v1/principal/prepaid-wallets/"+url.PathEscape(walletID)+"/activity"))
}
func (c *PrincipalPrepaidWalletClient) Assign(ctx context.Context, walletID string, params AssignPrepaidWalletParams) (*WalletAssignment, error) {
	return unmarshal[WalletAssignment](c.http.post(ctx, "/v1/principal/prepaid-wallets/"+url.PathEscape(walletID)+"/assignments", params))
}
func (c *PrincipalPrepaidWalletClient) SetAssignmentStatus(ctx context.Context, assignmentID, status, reason string) (*WalletAssignment, error) {
	return unmarshal[WalletAssignment](c.http.patch(ctx, "/v1/principal/prepaid-wallet-assignments/"+url.PathEscape(assignmentID), reasonBody("status", status, reason)))
}
func (c *PrincipalPrepaidWalletClient) SetWalletStatus(ctx context.Context, walletID, status, reason string) (*PrepaidWallet, error) {
	return unmarshal[PrepaidWallet](c.http.patch(ctx, "/v1/principal/prepaid-wallets/"+url.PathEscape(walletID)+"/status", reasonBody("status", status, reason)))
}
func (c *PrincipalPrepaidWalletClient) SetAgentBlocked(ctx context.Context, agentID string, blocked bool, reason string) (WalletRecord, error) {
	body := WalletRecord{"blocked": blocked}
	if reason != "" {
		body["reason"] = reason
	}
	return unmarshalValue[WalletRecord](c.http.put(ctx, "/v1/principal/prepaid-wallet-agents/"+url.PathEscape(agentID)+"/block", body))
}
func (c *PrincipalPrepaidWalletClient) Reload(ctx context.Context, walletID, amount, idempotencyKey, externalReference string) (*WalletReloadRequest, error) {
	body := WalletRecord{"amount": amount, "idempotencyKey": idempotencyKey}
	if externalReference != "" {
		body["externalReference"] = externalReference
	}
	return unmarshal[WalletReloadRequest](c.http.post(ctx, "/v1/principal/prepaid-wallets/"+url.PathEscape(walletID)+"/reloads", body))
}
func (c *PrincipalPrepaidWalletClient) DecideReload(ctx context.Context, requestID, decision string) (*WalletReloadRequest, error) {
	return unmarshal[WalletReloadRequest](c.http.post(ctx, "/v1/principal/prepaid-wallet-reload-requests/"+url.PathEscape(requestID)+"/decision", WalletRecord{"decision": decision}))
}
func (c *PrincipalPrepaidWalletClient) FundReload(ctx context.Context, requestID, externalReference string) (*WalletReloadRequest, error) {
	body := WalletRecord{}
	if externalReference != "" {
		body["externalReference"] = externalReference
	}
	return unmarshal[WalletReloadRequest](c.http.post(ctx, "/v1/principal/prepaid-wallet-reload-requests/"+url.PathEscape(requestID)+"/fund", body))
}
func (c *PrincipalPrepaidWalletClient) ReleaseReservation(ctx context.Context, reservationID, reason string) (WalletRecord, error) {
	return unmarshalValue[WalletRecord](c.http.post(ctx, "/v1/principal/prepaid-wallet-reservations/"+url.PathEscape(reservationID)+"/release", WalletRecord{"reason": reason}))
}
func (c *PrincipalPrepaidWalletClient) CreateSpendPolicy(ctx context.Context, params WalletSpendPolicyParams) (*WalletSpendPolicy, error) {
	return unmarshal[WalletSpendPolicy](c.http.post(ctx, "/v1/principal/prepaid-wallet-spend-policies", params))
}
func (c *PrincipalPrepaidWalletClient) ListSpendPolicies(ctx context.Context) ([]WalletSpendPolicy, error) {
	var response struct {
		Policies []WalletSpendPolicy `json:"policies"`
	}
	data, err := c.http.get(ctx, "/v1/principal/prepaid-wallet-spend-policies")
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, err
	}
	return response.Policies, nil
}
func (c *PrincipalPrepaidWalletClient) SetSpendPolicyStatus(ctx context.Context, policyID, status string) (*WalletSpendPolicy, error) {
	return unmarshal[WalletSpendPolicy](c.http.patch(ctx, "/v1/principal/prepaid-wallet-spend-policies/"+url.PathEscape(policyID)+"/status", WalletRecord{"status": status}))
}
func (c *PrincipalPrepaidWalletClient) ListPaymentApprovals(ctx context.Context) ([]WalletPaymentApproval, error) {
	var response struct {
		Approvals []WalletPaymentApproval `json:"approvals"`
	}
	data, err := c.http.get(ctx, "/v1/principal/prepaid-wallet-payment-approvals")
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, err
	}
	return response.Approvals, nil
}
func (c *PrincipalPrepaidWalletClient) DecidePaymentApproval(ctx context.Context, approvalID, decision, reason string) (*WalletPaymentApproval, error) {
	return unmarshal[WalletPaymentApproval](c.http.post(ctx, "/v1/principal/prepaid-wallet-payment-approvals/"+url.PathEscape(approvalID)+"/decision", reasonBody("decision", decision, reason)))
}

type AgentPrepaidWalletClient struct {
	http        *httpClient
	accessToken string
	privateKey  *ecdsa.PrivateKey
}

func NewAgentPrepaidWalletClient(accessToken string, privateKey *ecdsa.PrivateKey, resourceURL string, opts ...Option) (*AgentPrepaidWalletClient, error) {
	base, err := secureWalletURL(resourceURL, true)
	if err != nil {
		return nil, err
	}
	if !strings.HasSuffix(base, "/v1/prepaid-wallets") {
		return nil, errors.New("resourceURL must end with /v1/prepaid-wallets")
	}
	if accessToken == "" || privateKey == nil || privateKey.Curve != elliptic.P256() {
		return nil, errors.New("accessToken and a P-256 private key are required")
	}
	cfg := &clientConfig{baseURL: base, timeout: defaultTimeout}
	for _, opt := range opts {
		opt(cfg)
	}
	hc := cfg.httpClient
	if hc == nil {
		hc = &http.Client{Timeout: cfg.timeout}
	}
	return &AgentPrepaidWalletClient{http: &httpClient{baseURL: base, client: hc, maxRetriesSet: true}, accessToken: accessToken, privateKey: privateKey}, nil
}

func GenerateDPoPKey() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}
func (c *AgentPrepaidWalletClient) SetAccessToken(token string) error {
	if token == "" {
		return errors.New("access token is required")
	}
	c.accessToken = token
	return nil
}
func (c *AgentPrepaidWalletClient) List(ctx context.Context) ([]AssignedPrepaidWallet, error) {
	var response struct {
		Wallets []AssignedPrepaidWallet `json:"wallets"`
	}
	data, err := c.request(ctx, http.MethodGet, "", nil)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, err
	}
	return response.Wallets, nil
}

func secureWalletURL(raw string, requireResourcePath bool) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return "", errors.New("wallet URL must be an absolute HTTP(S) URL without credentials, query, or fragment")
	}
	host := parsed.Hostname()
	loopback := strings.EqualFold(host, "localhost")
	if address, parseErr := netip.ParseAddr(host); parseErr == nil {
		loopback = address.IsLoopback()
	}
	if parsed.Scheme == "http" && !loopback {
		return "", errors.New("remote wallet endpoints must use HTTPS")
	}
	base := strings.TrimRight(raw, "/")
	if requireResourcePath && !strings.HasSuffix(base, "/v1/prepaid-wallets") {
		return "", errors.New("resourceURL must end with /v1/prepaid-wallets")
	}
	return base, nil
}
func (c *AgentPrepaidWalletClient) AuthorizePayment(ctx context.Context, params PrepaidAuthorizationRequest) (*PrepaidAuthorizationResponse, error) {
	return unmarshal[PrepaidAuthorizationResponse](c.request(ctx, http.MethodPost, "/authorizations", params))
}
func (c *AgentPrepaidWalletClient) RequestReload(ctx context.Context, walletID, amount, idempotencyKey, reason string) (*WalletReloadRequest, error) {
	body := WalletRecord{"amount": amount, "idempotencyKey": idempotencyKey}
	if reason != "" {
		body["reason"] = reason
	}
	return unmarshal[WalletReloadRequest](c.request(ctx, http.MethodPost, "/"+url.PathEscape(walletID)+"/reload-requests", body))
}
func (c *AgentPrepaidWalletClient) request(ctx context.Context, method, path string, body any) ([]byte, error) {
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if body == nil {
		bodyBytes = nil
	}
	target := strings.TrimRight(c.http.baseURL, "/") + path
	proof, err := dpopProof(method, target, c.accessToken, c.privateKey)
	if err != nil {
		return nil, err
	}
	return c.http.doOnce(ctx, method, path, bodyBytes, map[string]string{"Authorization": "DPoP " + c.accessToken, "DPoP": proof})
}

func dpopProof(method, target, accessToken string, key *ecdsa.PrivateKey) (string, error) {
	encode := base64.RawURLEncoding.EncodeToString
	x := key.PublicKey.X.FillBytes(make([]byte, 32))
	y := key.PublicKey.Y.FillBytes(make([]byte, 32))
	ath := sha256.Sum256([]byte(accessToken))
	jtiBytes := make([]byte, 16)
	if _, err := rand.Read(jtiBytes); err != nil {
		return "", err
	}
	claims := jwt.MapClaims{"htm": strings.ToUpper(method), "htu": target, "iat": time.Now().Unix(), "jti": encode(jtiBytes), "ath": encode(ath[:])}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["typ"] = "dpop+jwt"
	token.Header["jwk"] = WalletRecord{"kty": "EC", "crv": "P-256", "x": encode(x), "y": encode(y)}
	return token.SignedString(key)
}

func reasonBody(key, value, reason string) WalletRecord {
	body := WalletRecord{key: value}
	if reason != "" {
		body["reason"] = reason
	}
	return body
}
func unmarshalValue[T any](data []byte, err error) (T, error) {
	var zero T
	if err != nil {
		return zero, err
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return zero, err
	}
	return value, nil
}
