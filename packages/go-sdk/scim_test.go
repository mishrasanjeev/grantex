package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSCIMCreateToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/scim/tokens" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ScimTokenWithSecret{
			ID:    "tok-1",
			Label: "Production",
			Token: "scim_secret_123",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	tok, err := client.SCIM.CreateToken(context.Background(), "Production")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tok.ID != "tok-1" {
		t.Errorf("expected tok-1, got %s", tok.ID)
	}
	if tok.Token != "scim_secret_123" {
		t.Errorf("expected scim_secret_123, got %s", tok.Token)
	}
}

func TestSCIMListTokens(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/scim/tokens" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListScimTokensResponse{
			Tokens: []ScimToken{{ID: "tok-1", Label: "Prod"}},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SCIM.ListTokens(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Tokens) != 1 {
		t.Errorf("expected 1 token, got %d", len(result.Tokens))
	}
}

func TestSCIMRevokeToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/scim/tokens/tok-1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.SCIM.RevokeToken(context.Background(), "tok-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSCIMListUsers(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/scim/v2/Users" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ScimListResponse{
			TotalResults: 1,
			StartIndex:   1,
			ItemsPerPage: 20,
			Resources:    []ScimUser{{ID: "user-1", UserName: "alice@example.com", Active: true}},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.SCIM.ListUsers(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.TotalResults != 1 {
		t.Errorf("expected 1, got %d", result.TotalResults)
	}
}

func TestSCIMGetUser(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/scim/v2/Users/user-1" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ScimUser{ID: "user-1", UserName: "alice@example.com"})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	user, err := client.SCIM.GetUser(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user.UserName != "alice@example.com" {
		t.Errorf("expected alice@example.com, got %s", user.UserName)
	}
}

func TestSCIMCreateUser(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/scim/v2/Users" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ScimUser{ID: "user-2", UserName: "bob@example.com", Active: true})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	user, err := client.SCIM.CreateUser(context.Background(), CreateScimUserParams{
		UserName: "bob@example.com",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user.ID != "user-2" {
		t.Errorf("expected user-2, got %s", user.ID)
	}
}

func TestSCIMReplaceUser(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/scim/v2/Users/user-1" || r.Method != http.MethodPut {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ScimUser{ID: "user-1", UserName: "alice-new@example.com"})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	user, err := client.SCIM.ReplaceUser(context.Background(), "user-1", CreateScimUserParams{
		UserName: "alice-new@example.com",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user.UserName != "alice-new@example.com" {
		t.Errorf("expected alice-new@example.com, got %s", user.UserName)
	}
}

func TestSCIMUpdateUser(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/scim/v2/Users/user-1" || r.Method != http.MethodPatch {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ScimUser{ID: "user-1", Active: false})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	user, err := client.SCIM.UpdateUser(context.Background(), "user-1", []ScimOperation{
		{Op: "replace", Path: "active", Value: false},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if user.Active {
		t.Error("expected active=false")
	}
}

func TestSCIMDeleteUser(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/scim/v2/Users/user-1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.SCIM.DeleteUser(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
