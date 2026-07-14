package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuditLog(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audit/log" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var payload map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode audit payload: %v", err)
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		required := map[string]string{
			"agentId": "agent-1", "agentDid": "did:grantex:agent-1",
			"grantId": "grant-1", "principalId": "user-1", "action": "data:read",
		}
		for key, want := range required {
			if got, ok := payload[key].(string); !ok || got != want {
				t.Errorf("expected %s=%q in wire payload, got %#v", key, want, payload[key])
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"entryId":     "entry-1",
			"agentId":     "agent-1",
			"agentDid":    "did:grantex:agent-1",
			"grantId":     "grant-1",
			"principalId": "user-1",
			"developerId": "dev-1",
			"action":      "data:read",
			"metadata":    map[string]interface{}{},
			"hash":        "abc123",
			"prevHash":    nil,
			"timestamp":   "2026-07-14T00:00:00Z",
			"status":      "success",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	entry, err := client.Audit.Log(context.Background(), LogAuditParams{
		AgentID:     "agent-1",
		AgentDID:    "did:grantex:agent-1",
		GrantID:     "grant-1",
		PrincipalID: "user-1",
		Action:      "data:read",
		Status:      "success",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if entry.EntryID != "entry-1" {
		t.Errorf("expected entry-1, got %s", entry.EntryID)
	}
	if entry.Action != "data:read" {
		t.Errorf("expected data:read, got %s", entry.Action)
	}
	if entry.DeveloperID != "dev-1" {
		t.Errorf("expected dev-1, got %s", entry.DeveloperID)
	}
}

func TestAuditList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audit/entries" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"entries": []map[string]interface{}{
				{"entryId": "entry-1", "developerId": "dev-1"},
				{"entryId": "entry-2", "developerId": "dev-1"},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Audit.List(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Entries) != 2 {
		t.Errorf("expected 2 entries, got %d", len(result.Entries))
	}
	if result.Entries[0].DeveloperID != "dev-1" {
		t.Errorf("expected dev-1, got %s", result.Entries[0].DeveloperID)
	}
}

func TestAuditListWithParams(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := map[string]string{
			"agentId": "agent-1", "grantId": "grant-1",
			"principalId": "user+ops@example.com", "action": "data:read&export=true",
		}
		query := r.URL.Query()
		if len(query) != len(want) {
			t.Errorf("expected only supported audit filters, got %v", query)
		}
		for key, value := range want {
			if query.Get(key) != value {
				t.Errorf("expected %s=%q, got %q", key, value, query.Get(key))
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"entries": []map[string]interface{}{{"entryId": "entry-1"}},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Audit.List(context.Background(), &ListAuditParams{
		AgentID:     "agent-1",
		GrantID:     "grant-1",
		PrincipalID: "user+ops@example.com",
		Action:      "data:read&export=true",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Entries) != 1 {
		t.Errorf("expected 1 entry, got %d", len(result.Entries))
	}
}

func TestAuditGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audit/entry-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"entryId": "entry-1", "developerId": "dev-1", "action": "data:read",
			"prevHash": nil,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	entry, err := client.Audit.Get(context.Background(), "entry-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if entry.EntryID != "entry-1" {
		t.Errorf("expected entry-1, got %s", entry.EntryID)
	}
	if entry.DeveloperID != "dev-1" {
		t.Errorf("expected dev-1, got %s", entry.DeveloperID)
	}
}
