package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTokensExchange(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/token" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ExchangeTokenResponse{
			GrantToken:   "jwt-token-123",
			ExpiresAt:    "2026-03-02T00:00:00Z",
			Scopes:       []string{"read:email"},
			RefreshToken: "refresh-abc",
			GrantID:      "grant-1",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Tokens.Exchange(context.Background(), ExchangeTokenParams{
		Code:    "auth-code-123",
		AgentID: "agent-1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.GrantToken != "jwt-token-123" {
		t.Errorf("expected jwt-token-123, got %s", result.GrantToken)
	}
	if result.RefreshToken != "refresh-abc" {
		t.Errorf("expected refresh-abc, got %s", result.RefreshToken)
	}
	if result.GrantID != "grant-1" {
		t.Errorf("expected grant-1, got %s", result.GrantID)
	}
}

func TestTokensExchangeWithPKCE(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["codeVerifier"] == "" {
			t.Error("expected codeVerifier in body")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ExchangeTokenResponse{
			GrantToken: "jwt-pkce",
			GrantID:    "grant-pkce",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Tokens.Exchange(context.Background(), ExchangeTokenParams{
		Code:         "code-123",
		AgentID:      "agent-1",
		CodeVerifier: "verifier-abc",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.GrantToken != "jwt-pkce" {
		t.Errorf("expected jwt-pkce, got %s", result.GrantToken)
	}
}

func TestTokensRefresh(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/token/refresh" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ExchangeTokenResponse{
			GrantToken:   "new-jwt-456",
			ExpiresAt:    "2026-03-02T00:00:00Z",
			Scopes:       []string{"read:email"},
			RefreshToken: "new-refresh-def",
			GrantID:      "grant-1",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Tokens.Refresh(context.Background(), RefreshTokenParams{
		RefreshToken: "old-refresh-abc",
		AgentID:      "agent-1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.GrantToken != "new-jwt-456" {
		t.Errorf("expected new-jwt-456, got %s", result.GrantToken)
	}
	if result.RefreshToken != "new-refresh-def" {
		t.Errorf("expected new-refresh-def, got %s", result.RefreshToken)
	}
}

func TestTokensVerify(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/tokens/verify" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["token"] == "" {
			t.Error("expected token in body")
		}
		grantID := "grant-1"
		principal := "user-1"
		agent := "did:grantex:agent-1"
		expiresAt := "2026-03-02T00:00:00Z"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(VerifyTokenResponse{
			Valid:     true,
			GrantID:   &grantID,
			Scopes:    []string{"read:email"},
			Principal: &principal,
			Agent:     &agent,
			ExpiresAt: &expiresAt,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Tokens.Verify(context.Background(), "some-jwt-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Valid {
		t.Error("expected valid=true")
	}
	if *result.GrantID != "grant-1" {
		t.Errorf("expected grant-1, got %s", *result.GrantID)
	}
}

func TestTokensRevoke(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/tokens/revoke" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["jti"] != "token-id-123" {
			t.Errorf("expected jti=token-id-123, got %s", body["jti"])
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.Tokens.Revoke(context.Background(), "token-id-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestTokensExchangeUnauthorized(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid api key"})
	}))
	defer server.Close()

	client := NewClient("bad-key", WithBaseURL(server.URL))
	_, err := client.Tokens.Exchange(context.Background(), ExchangeTokenParams{
		Code:    "code",
		AgentID: "agent",
	})
	if err == nil {
		t.Fatal("expected error")
	}
	_, ok := err.(*AuthError)
	if !ok {
		t.Fatalf("expected AuthError, got %T", err)
	}
}
