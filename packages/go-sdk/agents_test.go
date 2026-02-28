package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAgentsRegister(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agents" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Agent{
			ID:          "agent-1",
			DID:         "did:grantex:agent-1",
			Name:        "Test Agent",
			Description: "A test agent",
			Scopes:      []string{"read:email"},
			Status:      "active",
			DeveloperID: "dev-1",
			CreatedAt:   "2026-03-01T00:00:00Z",
			UpdatedAt:   "2026-03-01T00:00:00Z",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	agent, err := client.Agents.Register(context.Background(), RegisterAgentParams{
		Name:        "Test Agent",
		Description: "A test agent",
		Scopes:      []string{"read:email"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if agent.ID != "agent-1" {
		t.Errorf("expected agent-1, got %s", agent.ID)
	}
	if agent.DID != "did:grantex:agent-1" {
		t.Errorf("expected DID, got %s", agent.DID)
	}
}

func TestAgentsGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agents/agent-1" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Agent{ID: "agent-1", Name: "Test Agent"})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	agent, err := client.Agents.Get(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if agent.ID != "agent-1" {
		t.Errorf("expected agent-1, got %s", agent.ID)
	}
}

func TestAgentsList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agents" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListAgentsResponse{
			Agents:   []Agent{{ID: "agent-1"}, {ID: "agent-2"}},
			Total:    2,
			Page:     1,
			PageSize: 20,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Agents.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 2 {
		t.Errorf("expected 2 agents, got %d", result.Total)
	}
	if len(result.Agents) != 2 {
		t.Errorf("expected 2 agents in list, got %d", len(result.Agents))
	}
}

func TestAgentsUpdate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agents/agent-1" || r.Method != http.MethodPatch {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		name := "Updated Agent"
		json.NewEncoder(w).Encode(Agent{ID: "agent-1", Name: name})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	name := "Updated Agent"
	agent, err := client.Agents.Update(context.Background(), "agent-1", UpdateAgentParams{
		Name: &name,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if agent.Name != "Updated Agent" {
		t.Errorf("expected Updated Agent, got %s", agent.Name)
	}
}

func TestAgentsDelete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agents/agent-1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.Agents.Delete(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestAgentsRegisterError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "missing name"})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	_, err := client.Agents.Register(context.Background(), RegisterAgentParams{})
	if err == nil {
		t.Fatal("expected error")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected APIError, got %T", err)
	}
	if apiErr.StatusCode != 400 {
		t.Errorf("expected 400, got %d", apiErr.StatusCode)
	}
}
