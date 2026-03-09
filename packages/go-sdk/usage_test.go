package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUsageCurrent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/usage" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(UsageResponse{
			DeveloperID:    "dev-1",
			Period:         "2026-03",
			TokenExchanges: 150,
			Authorizations: 42,
			Verifications:  300,
			TotalRequests:  492,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	usage, err := client.Usage.Current(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if usage.DeveloperID != "dev-1" {
		t.Errorf("expected dev-1, got %s", usage.DeveloperID)
	}
	if usage.TotalRequests != 492 {
		t.Errorf("expected 492, got %d", usage.TotalRequests)
	}
}

func TestUsageHistory(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/usage/history" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("days") != "7" {
			t.Errorf("expected days=7, got %s", r.URL.Query().Get("days"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(usageHistoryResponse{
			Entries: []UsageHistoryEntry{
				{Date: "2026-03-01", TokenExchanges: 20, TotalRequests: 50},
				{Date: "2026-03-02", TokenExchanges: 25, TotalRequests: 60},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	entries, err := client.Usage.History(context.Background(), 7)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].Date != "2026-03-01" {
		t.Errorf("expected 2026-03-01, got %s", entries[0].Date)
	}
}
