package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGrantsGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/grants/grant-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Grant{
			ID:          "grant-1",
			AgentID:     "agent-1",
			PrincipalID: "user-1",
			Status:      "active",
			Scopes:      []string{"read:email"},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	grant, err := client.Grants.Get(context.Background(), "grant-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if grant.ID != "grant-1" {
		t.Errorf("expected grant-1, got %s", grant.ID)
	}
	if grant.Status != "active" {
		t.Errorf("expected active, got %s", grant.Status)
	}
}

func TestGrantsList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/grants" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListGrantsResponse{
			Grants:   []Grant{{ID: "grant-1"}, {ID: "grant-2"}},
			Total:    2,
			Page:     1,
			PageSize: 20,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Grants.List(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 2 {
		t.Errorf("expected 2 grants, got %d", result.Total)
	}
}

func TestGrantsListWithParams(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("agentId") != "agent-1" {
			t.Errorf("expected agentId=agent-1, got %s", r.URL.Query().Get("agentId"))
		}
		if r.URL.Query().Get("status") != "active" {
			t.Errorf("expected status=active, got %s", r.URL.Query().Get("status"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListGrantsResponse{
			Grants: []Grant{{ID: "grant-1"}},
			Total:  1,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Grants.List(context.Background(), &ListGrantsParams{
		AgentID: "agent-1",
		Status:  "active",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 1 {
		t.Errorf("expected 1 grant, got %d", result.Total)
	}
}

func TestGrantsRevoke(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/grants/grant-1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.Grants.Revoke(context.Background(), "grant-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGrantsDelegate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/grants/delegate" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(DelegateResponse{
			GrantToken: "delegated-jwt",
			ExpiresAt:  "2026-03-02T00:00:00Z",
			Scopes:     []string{"read:email"},
			GrantID:    "grant-delegated",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Grants.Delegate(context.Background(), DelegateParams{
		ParentGrantToken: "parent-jwt",
		SubAgentID:       "sub-agent-1",
		Scopes:           []string{"read:email"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.GrantToken != "delegated-jwt" {
		t.Errorf("expected delegated-jwt, got %s", result.GrantToken)
	}
	if result.GrantID != "grant-delegated" {
		t.Errorf("expected grant-delegated, got %s", result.GrantID)
	}
}

func TestGrantsGetNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"message": "grant not found"})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	_, err := client.Grants.Get(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected APIError, got %T", err)
	}
	if apiErr.StatusCode != 404 {
		t.Errorf("expected 404, got %d", apiErr.StatusCode)
	}
}
