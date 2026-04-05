package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVaultStore(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/vault/credentials" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params StoreCredentialParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.PrincipalID != "principal-1" {
			t.Errorf("expected principal-1, got %s", params.PrincipalID)
		}
		if params.Service != "github" {
			t.Errorf("expected github, got %s", params.Service)
		}
		if params.AccessToken != "ghp_xxx" {
			t.Errorf("expected ghp_xxx, got %s", params.AccessToken)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(StoreCredentialResponse{
			ID:             "cred-1",
			PrincipalID:    "principal-1",
			Service:        "github",
			CredentialType: "oauth2",
			CreatedAt:      "2026-04-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	resp, err := client.Vault.Store(context.Background(), StoreCredentialParams{
		PrincipalID: "principal-1",
		Service:     "github",
		AccessToken: "ghp_xxx",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.ID != "cred-1" {
		t.Errorf("expected cred-1, got %s", resp.ID)
	}
	if resp.Service != "github" {
		t.Errorf("expected github, got %s", resp.Service)
	}
}

func TestVaultList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/vault/credentials" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(listVaultCredentialsResponse{
			Credentials: []VaultCredential{
				{ID: "cred-1", PrincipalID: "principal-1", Service: "github", CredentialType: "oauth2", CreatedAt: "2026-04-01T00:00:00Z", UpdatedAt: "2026-04-01T00:00:00Z"},
				{ID: "cred-2", PrincipalID: "principal-1", Service: "slack", CredentialType: "oauth2", CreatedAt: "2026-04-01T00:00:00Z", UpdatedAt: "2026-04-01T00:00:00Z"},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	creds, err := client.Vault.List(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(creds) != 2 {
		t.Errorf("expected 2 credentials, got %d", len(creds))
	}
}

func TestVaultListWithParams(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("principalId") != "principal-1" {
			t.Errorf("expected principalId=principal-1, got %s", r.URL.Query().Get("principalId"))
		}
		if r.URL.Query().Get("service") != "github" {
			t.Errorf("expected service=github, got %s", r.URL.Query().Get("service"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(listVaultCredentialsResponse{
			Credentials: []VaultCredential{
				{ID: "cred-1", PrincipalID: "principal-1", Service: "github"},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	creds, err := client.Vault.List(context.Background(), &ListVaultCredentialsParams{
		PrincipalID: "principal-1",
		Service:     "github",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(creds) != 1 {
		t.Errorf("expected 1 credential, got %d", len(creds))
	}
}

func TestVaultGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/vault/credentials/cred-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(VaultCredential{
			ID:             "cred-1",
			PrincipalID:    "principal-1",
			Service:        "github",
			CredentialType: "oauth2",
			CreatedAt:      "2026-04-01T00:00:00Z",
			UpdatedAt:      "2026-04-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	cred, err := client.Vault.Get(context.Background(), "cred-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cred.ID != "cred-1" {
		t.Errorf("expected cred-1, got %s", cred.ID)
	}
	if cred.Service != "github" {
		t.Errorf("expected github, got %s", cred.Service)
	}
}

func TestVaultDelete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/vault/credentials/cred-1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.Vault.Delete(context.Background(), "cred-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestVaultExchange(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/vault/credentials/exchange" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		// Verify that the grant token is used as the Bearer token (not the API key)
		auth := r.Header.Get("Authorization")
		if auth != "Bearer grant-token-xyz" {
			t.Errorf("expected Bearer grant-token-xyz, got %s", auth)
		}
		var params ExchangeCredentialParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.Service != "github" {
			t.Errorf("expected github, got %s", params.Service)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ExchangeCredentialResponse{
			AccessToken:    "ghp_exchanged",
			Service:        "github",
			CredentialType: "oauth2",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	resp, err := client.Vault.Exchange(context.Background(), "grant-token-xyz", ExchangeCredentialParams{
		Service: "github",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.AccessToken != "ghp_exchanged" {
		t.Errorf("expected ghp_exchanged, got %s", resp.AccessToken)
	}
	if resp.Service != "github" {
		t.Errorf("expected github, got %s", resp.Service)
	}
}

func TestVaultExchangeError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "FORBIDDEN",
			"message": "insufficient scopes",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	_, err := client.Vault.Exchange(context.Background(), "bad-token", ExchangeCredentialParams{
		Service: "github",
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	authErr, ok := err.(*AuthError)
	if !ok {
		t.Fatalf("expected AuthError, got %T", err)
	}
	if authErr.StatusCode != http.StatusForbidden {
		t.Errorf("expected 403, got %d", authErr.StatusCode)
	}
}
