package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPoliciesCreate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/policies" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Policy{
			ID:       "pol-1",
			Name:     "Block after hours",
			Effect:   "deny",
			Priority: 1,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	pol, err := client.Policies.Create(context.Background(), CreatePolicyParams{
		Name:   "Block after hours",
		Effect: "deny",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pol.ID != "pol-1" {
		t.Errorf("expected pol-1, got %s", pol.ID)
	}
	if pol.Effect != "deny" {
		t.Errorf("expected deny, got %s", pol.Effect)
	}
}

func TestPoliciesList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/policies" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListPoliciesResponse{
			Policies: []Policy{{ID: "pol-1"}, {ID: "pol-2"}},
			Total:    2,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Policies.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Total != 2 {
		t.Errorf("expected 2, got %d", result.Total)
	}
}

func TestPoliciesGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/policies/pol-1" {
			t.Errorf("expected /v1/policies/pol-1, got %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Policy{ID: "pol-1", Name: "Test Policy"})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	pol, err := client.Policies.Get(context.Background(), "pol-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pol.ID != "pol-1" {
		t.Errorf("expected pol-1, got %s", pol.ID)
	}
}

func TestPoliciesUpdate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/policies/pol-1" || r.Method != http.MethodPatch {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Policy{ID: "pol-1", Name: "Updated Policy"})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	name := "Updated Policy"
	pol, err := client.Policies.Update(context.Background(), "pol-1", UpdatePolicyParams{
		Name: &name,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pol.Name != "Updated Policy" {
		t.Errorf("expected Updated Policy, got %s", pol.Name)
	}
}

func TestPoliciesDelete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/policies/pol-1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.Policies.Delete(context.Background(), "pol-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
