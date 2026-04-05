package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPassportsIssue(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/passport/issue" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var params IssuePassportParams
		json.NewDecoder(r.Body).Decode(&params)
		if params.AgentID != "agent-1" {
			t.Errorf("expected agent-1, got %s", params.AgentID)
		}
		if params.GrantID != "grant-1" {
			t.Errorf("expected grant-1, got %s", params.GrantID)
		}
		if len(params.AllowedMPPCategories) != 2 {
			t.Errorf("expected 2 categories, got %d", len(params.AllowedMPPCategories))
		}
		if params.MaxTransactionAmount.Amount != 100.0 {
			t.Errorf("expected amount 100, got %f", params.MaxTransactionAmount.Amount)
		}
		if params.MaxTransactionAmount.Currency != "USD" {
			t.Errorf("expected USD, got %s", params.MaxTransactionAmount.Currency)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(IssuedPassportResponse{
			PassportID:        "passport-1",
			Credential:        map[string]interface{}{"type": "AgentPassportCredential"},
			EncodedCredential: "eyJ...",
			ExpiresAt:         "2026-04-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	resp, err := client.Passports.Issue(context.Background(), IssuePassportParams{
		AgentID:              "agent-1",
		GrantID:              "grant-1",
		AllowedMPPCategories: []string{"compute", "storage"},
		MaxTransactionAmount: TransactionAmount{Amount: 100.0, Currency: "USD"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.PassportID != "passport-1" {
		t.Errorf("expected passport-1, got %s", resp.PassportID)
	}
	if resp.EncodedCredential != "eyJ..." {
		t.Errorf("expected eyJ..., got %s", resp.EncodedCredential)
	}
}

func TestPassportsGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/passport/passport-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(GetPassportResponse{
			Status: "active",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	resp, err := client.Passports.Get(context.Background(), "passport-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Status != "active" {
		t.Errorf("expected active, got %s", resp.Status)
	}
}

func TestPassportsRevoke(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/passport/passport-1/revoke" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(RevokePassportResponse{
			Revoked:   true,
			RevokedAt: "2026-04-01T12:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	resp, err := client.Passports.Revoke(context.Background(), "passport-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.Revoked {
		t.Error("expected passport to be revoked")
	}
	if resp.RevokedAt != "2026-04-01T12:00:00Z" {
		t.Errorf("expected 2026-04-01T12:00:00Z, got %s", resp.RevokedAt)
	}
}

func TestPassportsList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/passports" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]IssuedPassportResponse{
			{PassportID: "passport-1", ExpiresAt: "2026-04-01T00:00:00Z"},
			{PassportID: "passport-2", ExpiresAt: "2026-05-01T00:00:00Z"},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	passports, err := client.Passports.List(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(passports) != 2 {
		t.Errorf("expected 2 passports, got %d", len(passports))
	}
}

func TestPassportsListWithParams(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("agentId") != "agent-1" {
			t.Errorf("expected agentId=agent-1, got %s", r.URL.Query().Get("agentId"))
		}
		if r.URL.Query().Get("status") != "active" {
			t.Errorf("expected status=active, got %s", r.URL.Query().Get("status"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]IssuedPassportResponse{
			{PassportID: "passport-1"},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	passports, err := client.Passports.List(context.Background(), &ListPassportsParams{
		AgentID: "agent-1",
		Status:  "active",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(passports) != 1 {
		t.Errorf("expected 1 passport, got %d", len(passports))
	}
}
