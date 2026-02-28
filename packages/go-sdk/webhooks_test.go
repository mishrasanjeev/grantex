package grantex

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWebhooksCreate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webhooks" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(WebhookEndpointWithSecret{
			ID:        "wh-1",
			URL:       "https://example.com/webhook",
			Events:    []string{"grant.created", "grant.revoked"},
			CreatedAt: "2026-03-01T00:00:00Z",
			Secret:    "whsec_abc123",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	wh, err := client.Webhooks.Create(context.Background(), CreateWebhookParams{
		URL:    "https://example.com/webhook",
		Events: []string{"grant.created", "grant.revoked"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if wh.ID != "wh-1" {
		t.Errorf("expected wh-1, got %s", wh.ID)
	}
	if wh.Secret != "whsec_abc123" {
		t.Errorf("expected whsec_abc123, got %s", wh.Secret)
	}
}

func TestWebhooksList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webhooks" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ListWebhooksResponse{
			Webhooks: []WebhookEndpoint{{ID: "wh-1"}, {ID: "wh-2"}},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Webhooks.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Webhooks) != 2 {
		t.Errorf("expected 2 webhooks, got %d", len(result.Webhooks))
	}
}

func TestWebhooksDelete(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webhooks/wh-1" || r.Method != http.MethodDelete {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	err := client.Webhooks.Delete(context.Background(), "wh-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestVerifyWebhookSignatureValid(t *testing.T) {
	secret := "whsec_test_secret"
	payload := []byte(`{"event":"grant.created","data":{"grantId":"g-1"}}`)

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if !VerifyWebhookSignature(payload, sig, secret) {
		t.Error("expected valid signature")
	}
}

func TestVerifyWebhookSignatureInvalid(t *testing.T) {
	if VerifyWebhookSignature([]byte("payload"), "sha256=deadbeef", "secret") {
		t.Error("expected invalid signature")
	}
}

func TestVerifyWebhookSignatureBadFormat(t *testing.T) {
	if VerifyWebhookSignature([]byte("payload"), "bad-format", "secret") {
		t.Error("expected false for bad format")
	}
}

func TestVerifyWebhookSignatureShort(t *testing.T) {
	if VerifyWebhookSignature([]byte("payload"), "sha256", "secret") {
		t.Error("expected false for too-short signature")
	}
}

func TestVerifyWebhookSignatureBadHex(t *testing.T) {
	if VerifyWebhookSignature([]byte("payload"), "sha256=not-hex-at-all!!!", "secret") {
		t.Error("expected false for bad hex")
	}
}
