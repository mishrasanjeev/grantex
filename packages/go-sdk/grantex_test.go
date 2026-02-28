package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewClient(t *testing.T) {
	client := NewClient("test-key")
	if client == nil {
		t.Fatal("expected non-nil client")
	}
	if client.Agents == nil {
		t.Error("expected Agents service")
	}
	if client.Tokens == nil {
		t.Error("expected Tokens service")
	}
	if client.Grants == nil {
		t.Error("expected Grants service")
	}
	if client.Audit == nil {
		t.Error("expected Audit service")
	}
	if client.Webhooks == nil {
		t.Error("expected Webhooks service")
	}
	if client.Billing == nil {
		t.Error("expected Billing service")
	}
	if client.Policies == nil {
		t.Error("expected Policies service")
	}
	if client.Compliance == nil {
		t.Error("expected Compliance service")
	}
	if client.Anomalies == nil {
		t.Error("expected Anomalies service")
	}
	if client.SCIM == nil {
		t.Error("expected SCIM service")
	}
	if client.SSO == nil {
		t.Error("expected SSO service")
	}
	if client.PrincipalSessions == nil {
		t.Error("expected PrincipalSessions service")
	}
}

func TestNewClientWithOptions(t *testing.T) {
	customClient := &http.Client{}
	client := NewClient("key",
		WithBaseURL("https://custom.api.com"),
		WithHTTPClient(customClient),
	)
	if client.http.baseURL != "https://custom.api.com" {
		t.Errorf("expected custom base URL, got %s", client.http.baseURL)
	}
	if client.http.client != customClient {
		t.Error("expected custom HTTP client")
	}
}

func TestAuthorize(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/authorize" {
			t.Errorf("expected /v1/authorize, got %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(AuthorizationRequest{
			AuthRequestID: "req-123",
			ConsentURL:    "https://consent.example.com",
			AgentID:       "agent-1",
			PrincipalID:   "user-1",
			Scopes:        []string{"read:email"},
			ExpiresAt:     "2026-03-01T00:00:00Z",
			Status:        "pending",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Authorize(context.Background(), AuthorizeParams{
		AgentID:     "agent-1",
		PrincipalID: "user-1",
		Scopes:      []string{"read:email"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.AuthRequestID != "req-123" {
		t.Errorf("expected req-123, got %s", result.AuthRequestID)
	}
	if result.ConsentURL != "https://consent.example.com" {
		t.Errorf("expected consent URL, got %s", result.ConsentURL)
	}
}

func TestRotateKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/developers/rotate-key" {
			t.Errorf("expected /v1/developers/rotate-key, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RotateKeyResponse{
			APIKey:    "new-key-123",
			RotatedAt: "2026-03-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.RotateKey(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.APIKey != "new-key-123" {
		t.Errorf("expected new-key-123, got %s", result.APIKey)
	}
}

func TestSignup(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/developers/signup" {
			t.Errorf("expected /v1/developers/signup, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SignupResponse{
			DeveloperID: "dev-123",
			APIKey:      "key-abc",
			Name:        "Test Dev",
			Mode:        "sandbox",
			CreatedAt:   "2026-03-01T00:00:00Z",
		})
	}))
	defer server.Close()

	result, err := Signup(context.Background(), SignupParams{
		Name: "Test Dev",
	}, WithBaseURL(server.URL))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.DeveloperID != "dev-123" {
		t.Errorf("expected dev-123, got %s", result.DeveloperID)
	}
	if result.APIKey != "key-abc" {
		t.Errorf("expected key-abc, got %s", result.APIKey)
	}
}
