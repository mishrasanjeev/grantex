package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPrincipalSessionsCreate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/principal-sessions" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body CreatePrincipalSessionParams
		json.NewDecoder(r.Body).Decode(&body)
		if body.PrincipalID != "user-1" {
			t.Errorf("expected principalId=user-1, got %s", body.PrincipalID)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(PrincipalSessionResponse{
			SessionToken: "session-jwt-123",
			DashboardURL: "https://api.grantex.dev/permissions?token=session-jwt-123",
			ExpiresAt:    "2026-03-01T01:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.PrincipalSessions.Create(context.Background(), CreatePrincipalSessionParams{
		PrincipalID: "user-1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SessionToken != "session-jwt-123" {
		t.Errorf("expected session-jwt-123, got %s", result.SessionToken)
	}
	if result.DashboardURL == "" {
		t.Error("expected dashboard URL")
	}
}

func TestPrincipalSessionsCreateWithExpiresIn(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body CreatePrincipalSessionParams
		json.NewDecoder(r.Body).Decode(&body)
		if body.ExpiresIn != "2h" {
			t.Errorf("expected expiresIn=2h, got %s", body.ExpiresIn)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(PrincipalSessionResponse{
			SessionToken: "session-jwt-456",
			DashboardURL: "https://api.grantex.dev/permissions?token=session-jwt-456",
			ExpiresAt:    "2026-03-01T02:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.PrincipalSessions.Create(context.Background(), CreatePrincipalSessionParams{
		PrincipalID: "user-1",
		ExpiresIn:   "2h",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SessionToken != "session-jwt-456" {
		t.Errorf("expected session-jwt-456, got %s", result.SessionToken)
	}
}

func TestPrincipalSessionsCreateUnauthorized(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid api key"})
	}))
	defer server.Close()

	client := NewClient("bad-key", WithBaseURL(server.URL))
	_, err := client.PrincipalSessions.Create(context.Background(), CreatePrincipalSessionParams{
		PrincipalID: "user-1",
	})
	if err == nil {
		t.Fatal("expected error")
	}
	_, ok := err.(*AuthError)
	if !ok {
		t.Fatalf("expected AuthError, got %T", err)
	}
}
