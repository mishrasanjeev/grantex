package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCredentialsGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/credentials/vc-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(VerifiableCredentialRecord{
			ID:           "vc-1",
			Type:         []string{"VerifiableCredential", "GrantCredential"},
			Issuer:       "did:web:grantex.dev",
			Subject:      "did:key:z6Mk...",
			GrantID:      "grant-1",
			Status:       "active",
			IssuanceDate: "2026-03-01T00:00:00Z",
			JWT:          "eyJ...",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	vc, err := client.Credentials.Get(context.Background(), "vc-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if vc.ID != "vc-1" {
		t.Errorf("expected vc-1, got %s", vc.ID)
	}
	if vc.Issuer != "did:web:grantex.dev" {
		t.Errorf("expected did:web:grantex.dev, got %s", vc.Issuer)
	}
	if len(vc.Type) != 2 {
		t.Errorf("expected 2 types, got %d", len(vc.Type))
	}
}

func TestCredentialsList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/credentials" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(listCredentialsResponse{
			Credentials: []VerifiableCredentialRecord{
				{ID: "vc-1", Status: "active"},
				{ID: "vc-2", Status: "active"},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	creds, err := client.Credentials.List(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(creds) != 2 {
		t.Errorf("expected 2 credentials, got %d", len(creds))
	}
}

func TestCredentialsListWithParams(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("grantId") != "grant-1" {
			t.Errorf("expected grantId=grant-1, got %s", r.URL.Query().Get("grantId"))
		}
		if r.URL.Query().Get("status") != "active" {
			t.Errorf("expected status=active, got %s", r.URL.Query().Get("status"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(listCredentialsResponse{
			Credentials: []VerifiableCredentialRecord{
				{ID: "vc-1", GrantID: "grant-1", Status: "active"},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	creds, err := client.Credentials.List(context.Background(), &ListCredentialsParams{
		GrantID: "grant-1",
		Status:  "active",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(creds) != 1 {
		t.Errorf("expected 1 credential, got %d", len(creds))
	}
}

func TestCredentialsVerify(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/credentials/verify" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(VCVerificationResult{
			Valid: true,
			CredentialSubject: map[string]interface{}{
				"grantId": "grant-1",
			},
			Issuer: "did:web:grantex.dev",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Credentials.Verify(context.Background(), "eyJ...")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Valid {
		t.Error("expected credential to be valid")
	}
	if result.Issuer != "did:web:grantex.dev" {
		t.Errorf("expected did:web:grantex.dev, got %s", result.Issuer)
	}
}

func TestCredentialsPresent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/credentials/present" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params SDJWTPresentParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.SDJWT != "sd-jwt-token" {
			t.Errorf("expected sd-jwt-token, got %s", params.SDJWT)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SDJWTPresentResult{
			Presentation: "presentation-jwt",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Credentials.Present(context.Background(), SDJWTPresentParams{
		SDJWT:           "sd-jwt-token",
		DisclosedClaims: []string{"grantId", "scopes"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Presentation != "presentation-jwt" {
		t.Errorf("expected presentation-jwt, got %s", result.Presentation)
	}
}
