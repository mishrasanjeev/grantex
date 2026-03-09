package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDomainsCreate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/domains" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params CreateDomainParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.Domain != "example.com" {
			t.Errorf("expected example.com, got %s", params.Domain)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Domain{
			ID:                "dom-1",
			Domain:            "example.com",
			Verified:          false,
			VerificationToken: "verify-token-123",
			Instructions:      "Add a TXT record...",
			CreatedAt:         "2026-03-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	domain, err := client.Domains.Create(context.Background(), CreateDomainParams{
		Domain: "example.com",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if domain.ID != "dom-1" {
		t.Errorf("expected dom-1, got %s", domain.ID)
	}
	if domain.Verified {
		t.Error("expected domain to not be verified")
	}
	if domain.VerificationToken != "verify-token-123" {
		t.Errorf("expected verify-token-123, got %s", domain.VerificationToken)
	}
}

func TestDomainsList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/domains" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(listDomainsResponse{
			Domains: []Domain{
				{ID: "dom-1", Domain: "example.com", Verified: true},
				{ID: "dom-2", Domain: "api.example.com", Verified: false},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	domains, err := client.Domains.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(domains) != 2 {
		t.Errorf("expected 2 domains, got %d", len(domains))
	}
}

func TestDomainsVerify(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/domains/dom-1/verify" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(VerifyDomainResponse{
			Verified: true,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Domains.Verify(context.Background(), "dom-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Verified {
		t.Error("expected domain to be verified")
	}
}

func TestDomainsDelete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/domains/dom-1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.Domains.Delete(context.Background(), "dom-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
