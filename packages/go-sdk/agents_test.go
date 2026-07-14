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
		json.NewEncoder(w).Encode(map[string]interface{}{
			"agentId":     "agent-1",
			"did":         "did:grantex:agent-1",
			"name":        "Test Agent",
			"description": "A test agent",
			"scopes":      []string{"read:email"},
			"status":      "active",
			"developerId": "dev-1",
			"createdAt":   "2026-03-01T00:00:00Z",
			"updatedAt":   "2026-03-01T00:00:00Z",
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

func TestAgentsRegisterOmitsOptionalZeroValues(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agents" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var payload map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode register payload: %v", err)
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		if len(payload) != 1 || payload["name"] != "Minimal Agent" {
			t.Errorf("expected only required name, got %#v", payload)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"agentId": "agent-1"})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	agent, err := client.Agents.Register(context.Background(), RegisterAgentParams{Name: "Minimal Agent"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if agent.ID != "agent-1" {
		t.Errorf("expected agent-1, got %s", agent.ID)
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
		json.NewEncoder(w).Encode(map[string]interface{}{
			"agents": []map[string]interface{}{
				{"agentId": "agent-1"},
				{"agentId": "agent-2"},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Agents.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Agents) != 2 {
		t.Fatalf("expected 2 agents in list, got %d", len(result.Agents))
	}
	if result.Agents[0].ID != "agent-1" || result.Agents[1].ID != "agent-2" {
		t.Errorf("unexpected agent IDs: %#v", result.Agents)
	}
}

func TestAgentsUpdate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agents/agent-1" || r.Method != http.MethodPatch {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		name := "Updated Agent"
		var payload map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode update payload: %v", err)
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		scopes, ok := payload["scopes"].([]interface{})
		if !ok || len(scopes) != 0 {
			t.Errorf("expected explicit empty scopes array, got %#v", payload["scopes"])
		}
		if payload["status"] != "suspended" {
			t.Errorf("expected status=suspended, got %#v", payload["status"])
		}
		json.NewEncoder(w).Encode(Agent{ID: "agent-1", Name: name, Status: "suspended"})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	name := "Updated Agent"
	status := "suspended"
	agent, err := client.Agents.Update(context.Background(), "agent-1", UpdateAgentParams{
		Name:   &name,
		Scopes: []string{},
		Status: &status,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if agent.Name != "Updated Agent" {
		t.Errorf("expected Updated Agent, got %s", agent.Name)
	}
	if agent.Status != "suspended" {
		t.Errorf("expected suspended, got %s", agent.Status)
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
