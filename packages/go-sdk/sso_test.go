package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSSOCreateConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/config" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoConfig{
			IssuerURL:   "https://accounts.google.com",
			ClientID:    "client-123",
			RedirectURI: "https://example.com/callback",
			CreatedAt:   "2026-03-01T00:00:00Z",
			UpdatedAt:   "2026-03-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	config, err := client.SSO.CreateConfig(context.Background(), CreateSsoConfigParams{
		IssuerURL:    "https://accounts.google.com",
		ClientID:     "client-123",
		ClientSecret: "secret-abc",
		RedirectURI:  "https://example.com/callback",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if config.IssuerURL != "https://accounts.google.com" {
		t.Errorf("expected google issuer, got %s", config.IssuerURL)
	}
}

func TestSSOGetConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/config" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoConfig{
			IssuerURL: "https://accounts.google.com",
			ClientID:  "client-123",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	config, err := client.SSO.GetConfig(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if config.ClientID != "client-123" {
		t.Errorf("expected client-123, got %s", config.ClientID)
	}
}

func TestSSODeleteConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/config" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.SSO.DeleteConfig(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSSOGetLoginURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/login" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("org") != "acme-corp" {
			t.Errorf("expected org=acme-corp, got %s", r.URL.Query().Get("org"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoLoginResponse{
			AuthorizeURL: "https://accounts.google.com/authorize?client_id=123",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.GetLoginURL(context.Background(), "acme-corp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.AuthorizeURL == "" {
		t.Error("expected authorize URL")
	}
}

func TestSSOHandleCallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sso/callback" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		email := "alice@example.com"
		name := "Alice"
		sub := "sub-123"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SsoCallbackResponse{
			Email:       &email,
			Name:        &name,
			Sub:         &sub,
			DeveloperID: "dev-1",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SSO.HandleCallback(context.Background(), "auth-code", "state-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if *result.Email != "alice@example.com" {
		t.Errorf("expected alice@example.com, got %s", *result.Email)
	}
	if result.DeveloperID != "dev-1" {
		t.Errorf("expected dev-1, got %s", result.DeveloperID)
	}
}
