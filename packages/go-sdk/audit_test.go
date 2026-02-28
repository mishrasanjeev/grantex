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
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(AuditEntry{
			EntryID:     "entry-1",
			AgentID:     "agent-1",
			GrantID:     "grant-1",
			PrincipalID: "user-1",
			Action:      "data:read",
			Status:      "success",
			Hash:        "abc123",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	entry, err := client.Audit.Log(context.Background(), LogAuditParams{
		AgentID: "agent-1",
		GrantID: "grant-1",
		Action:  "data:read",
		Status:  "success",
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
}

func TestAuditList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audit/entries" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListAuditResponse{
			Entries:  []AuditEntry{{EntryID: "entry-1"}, {EntryID: "entry-2"}},
			Total:    2,
			Page:     1,
			PageSize: 20,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Audit.List(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 2 {
		t.Errorf("expected 2, got %d", result.Total)
	}
}

func TestAuditListWithParams(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("agentId") != "agent-1" {
			t.Errorf("expected agentId=agent-1")
		}
		if r.URL.Query().Get("action") != "data:read" {
			t.Errorf("expected action=data:read")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListAuditResponse{
			Entries: []AuditEntry{{EntryID: "entry-1"}},
			Total:   1,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Audit.List(context.Background(), &ListAuditParams{
		AgentID: "agent-1",
		Action:  "data:read",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 1 {
		t.Errorf("expected 1, got %d", result.Total)
	}
}

func TestAuditGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audit/entry-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(AuditEntry{EntryID: "entry-1", Action: "data:read"})
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
}
