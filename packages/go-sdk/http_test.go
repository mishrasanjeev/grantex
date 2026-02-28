package grantex

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPClientGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("expected Bearer test-key, got %s", r.Header.Get("Authorization"))
		}
		if r.Header.Get("User-Agent") != "grantex-go/"+sdkVersion {
			t.Errorf("unexpected User-Agent: %s", r.Header.Get("User-Agent"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}))
	defer server.Close()

	h := &httpClient{baseURL: server.URL, apiKey: "test-key", client: http.DefaultClient}
	data, err := h.get(context.Background(), "/test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var result map[string]string
	json.Unmarshal(data, &result)
	if result["status"] != "ok" {
		t.Errorf("expected status ok, got %s", result["status"])
	}
}

func TestHTTPClientPost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected application/json content type")
		}
		body, _ := io.ReadAll(r.Body)
		var parsed map[string]string
		json.Unmarshal(body, &parsed)
		if parsed["name"] != "test" {
			t.Errorf("expected name=test, got %s", parsed["name"])
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id": "123"})
	}))
	defer server.Close()

	h := &httpClient{baseURL: server.URL, apiKey: "test-key", client: http.DefaultClient}
	data, err := h.post(context.Background(), "/test", map[string]string{"name": "test"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var result map[string]string
	json.Unmarshal(data, &result)
	if result["id"] != "123" {
		t.Errorf("expected id 123, got %s", result["id"])
	}
}

func TestHTTPClientPut(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("expected PUT, got %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"updated": "true"})
	}))
	defer server.Close()

	h := &httpClient{baseURL: server.URL, apiKey: "test-key", client: http.DefaultClient}
	data, err := h.put(context.Background(), "/test", map[string]string{"name": "updated"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data == nil {
		t.Fatal("expected response data")
	}
}

func TestHTTPClientPatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Errorf("expected PATCH, got %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"patched": "true"})
	}))
	defer server.Close()

	h := &httpClient{baseURL: server.URL, apiKey: "test-key", client: http.DefaultClient}
	data, err := h.patch(context.Background(), "/test", map[string]string{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data == nil {
		t.Fatal("expected response data")
	}
}

func TestHTTPClientDelete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	h := &httpClient{baseURL: server.URL, apiKey: "test-key", client: http.DefaultClient}
	data, err := h.del(context.Background(), "/test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if data != nil {
		t.Error("expected nil data for 204")
	}
}

func TestHTTPClientAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "Bad Request",
			"code":    "BAD_REQUEST",
			"message": "invalid params",
		})
	}))
	defer server.Close()

	h := &httpClient{baseURL: server.URL, apiKey: "test-key", client: http.DefaultClient}
	_, err := h.get(context.Background(), "/test")
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
	if apiErr.Code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST, got %s", apiErr.Code)
	}
}

func TestHTTPClientAuthError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
	}))
	defer server.Close()

	h := &httpClient{baseURL: server.URL, apiKey: "bad-key", client: http.DefaultClient}
	_, err := h.get(context.Background(), "/test")

	_, ok := err.(*AuthError)
	if !ok {
		t.Fatalf("expected AuthError, got %T", err)
	}
}

func TestHTTPClientForbiddenError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"error": "forbidden"})
	}))
	defer server.Close()

	h := &httpClient{baseURL: server.URL, apiKey: "test-key", client: http.DefaultClient}
	_, err := h.get(context.Background(), "/test")

	_, ok := err.(*AuthError)
	if !ok {
		t.Fatalf("expected AuthError for 403, got %T", err)
	}
}

func TestHTTPClientNetworkError(t *testing.T) {
	h := &httpClient{baseURL: "http://localhost:1", apiKey: "test-key", client: http.DefaultClient}
	_, err := h.get(context.Background(), "/test")

	_, ok := err.(*NetworkError)
	if !ok {
		t.Fatalf("expected NetworkError, got %T", err)
	}
}

func TestHTTPClientServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("internal error"))
	}))
	defer server.Close()

	h := &httpClient{baseURL: server.URL, apiKey: "test-key", client: http.DefaultClient}
	_, err := h.get(context.Background(), "/test")

	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected APIError, got %T", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("expected 500, got %d", apiErr.StatusCode)
	}
}

func TestHTTPClientNotFoundError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"message": "not found"})
	}))
	defer server.Close()

	h := &httpClient{baseURL: server.URL, apiKey: "test-key", client: http.DefaultClient}
	_, err := h.get(context.Background(), "/test")

	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected APIError, got %T", err)
	}
	if apiErr.StatusCode != 404 {
		t.Errorf("expected 404, got %d", apiErr.StatusCode)
	}
}

func TestBuildQueryString(t *testing.T) {
	tests := []struct {
		name   string
		params map[string]string
		want   string
	}{
		{"empty", map[string]string{}, ""},
		{"nil values filtered", map[string]string{"a": "", "b": "1"}, "?b=1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildQueryString(tt.params)
			if tt.want == "" && got != "" {
				t.Errorf("expected empty, got %s", got)
			}
			if tt.want != "" && got == "" {
				t.Errorf("expected %s, got empty", tt.want)
			}
		})
	}
}

func TestUnmarshalError(t *testing.T) {
	_, err := unmarshal[Agent]([]byte("not json"), nil)
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
	_, ok := err.(*NetworkError)
	if !ok {
		t.Fatalf("expected NetworkError for bad JSON, got %T", err)
	}
}

func TestUnmarshalNilData(t *testing.T) {
	result, err := unmarshal[Agent](nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Error("expected nil result for nil data")
	}
}

func TestUnmarshalPassthroughError(t *testing.T) {
	expectedErr := &APIError{StatusCode: 400, Message: "bad"}
	_, err := unmarshal[Agent](nil, expectedErr)
	if err != expectedErr {
		t.Error("expected passthrough error")
	}
}
