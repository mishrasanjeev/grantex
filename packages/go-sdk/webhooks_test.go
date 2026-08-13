package grantex

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
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

// ── Timestamped verification (replay-bounded) ──────────────────────────────

const tsSecret = "whsec_test"
const tsPayload = `{"id":"evt_1","type":"grant.created"}`

func signTimestamped(timestamp, payload, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write([]byte(payload))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func nowUnix() int64 { return time.Now().Unix() }

func TestVerifyWebhookAcceptsFreshDelivery(t *testing.T) {
	ts := strconv.FormatInt(nowUnix(), 10)
	if !VerifyWebhook([]byte(tsPayload), signTimestamped(ts, tsPayload, tsSecret), ts, tsSecret, DefaultWebhookToleranceSeconds) {
		t.Fatal("expected a fresh, correctly signed delivery to verify")
	}
}

// The whole point of the scheme: a delivery captured today must not still
// verify tomorrow, which is exactly what the payload-only signature allowed.
func TestVerifyWebhookRejectsReplayAfterWindow(t *testing.T) {
	ts := strconv.FormatInt(nowUnix()-301, 10)
	if VerifyWebhook([]byte(tsPayload), signTimestamped(ts, tsPayload, tsSecret), ts, tsSecret, DefaultWebhookToleranceSeconds) {
		t.Fatal("expected a delivery past the tolerance window to be rejected")
	}
}

func TestVerifyWebhookAcceptsInsideWindow(t *testing.T) {
	ts := strconv.FormatInt(nowUnix()-299, 10)
	if !VerifyWebhook([]byte(tsPayload), signTimestamped(ts, tsPayload, tsSecret), ts, tsSecret, DefaultWebhookToleranceSeconds) {
		t.Fatal("expected a delivery inside the window to verify")
	}
}

func TestVerifyWebhookRejectsFutureDatedDelivery(t *testing.T) {
	ts := strconv.FormatInt(nowUnix()+3600, 10)
	if VerifyWebhook([]byte(tsPayload), signTimestamped(ts, tsPayload, tsSecret), ts, tsSecret, DefaultWebhookToleranceSeconds) {
		t.Fatal("expected a future-dated delivery to be rejected")
	}
}

// The signature covers the timestamp, so refreshing the header alone fails.
func TestVerifyWebhookRejectsRewrittenTimestamp(t *testing.T) {
	signedAt := strconv.FormatInt(nowUnix()-3600, 10)
	sig := signTimestamped(signedAt, tsPayload, tsSecret)
	fresh := strconv.FormatInt(nowUnix(), 10)
	if VerifyWebhook([]byte(tsPayload), sig, fresh, tsSecret, DefaultWebhookToleranceSeconds) {
		t.Fatal("expected a rewritten timestamp to be rejected")
	}
}

func TestVerifyWebhookRejectsTamperedBody(t *testing.T) {
	ts := strconv.FormatInt(nowUnix(), 10)
	sig := signTimestamped(ts, tsPayload, tsSecret)
	if VerifyWebhook([]byte(`{"id":"evt_1","type":"grant.deleted"}`), sig, ts, tsSecret, DefaultWebhookToleranceSeconds) {
		t.Fatal("expected a tampered body to be rejected")
	}
}

func TestVerifyWebhookRejectsWrongSecret(t *testing.T) {
	ts := strconv.FormatInt(nowUnix(), 10)
	sig := signTimestamped(ts, tsPayload, "whsec_other")
	if VerifyWebhook([]byte(tsPayload), sig, ts, tsSecret, DefaultWebhookToleranceSeconds) {
		t.Fatal("expected a signature from another secret to be rejected")
	}
}

func TestVerifyWebhookRejectsLegacyPayloadOnlySignature(t *testing.T) {
	ts := strconv.FormatInt(nowUnix(), 10)
	mac := hmac.New(sha256.New, []byte(tsSecret))
	mac.Write([]byte(tsPayload))
	legacy := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if VerifyWebhook([]byte(tsPayload), legacy, ts, tsSecret, DefaultWebhookToleranceSeconds) {
		t.Fatal("expected a legacy payload-only signature to be rejected")
	}
}

func TestVerifyWebhookRejectsMalformedInputs(t *testing.T) {
	ts := strconv.FormatInt(nowUnix(), 10)
	valid := signTimestamped(ts, tsPayload, tsSecret)

	for _, timestamp := range []string{"", "not-a-time", "-100", strings.Repeat("9", 40)} {
		sig := signTimestamped(timestamp, tsPayload, tsSecret)
		if VerifyWebhook([]byte(tsPayload), sig, timestamp, tsSecret, DefaultWebhookToleranceSeconds) {
			t.Fatalf("expected timestamp %q to be rejected", timestamp)
		}
	}

	for _, sig := range []string{"", "garbage", "sha256=", "sha256=zz"} {
		if VerifyWebhook([]byte(tsPayload), sig, ts, tsSecret, DefaultWebhookToleranceSeconds) {
			t.Fatalf("expected signature %q to be rejected", sig)
		}
	}

	// Sanity: the valid case still passes, so the loop above is not vacuous.
	if !VerifyWebhook([]byte(tsPayload), valid, ts, tsSecret, DefaultWebhookToleranceSeconds) {
		t.Fatal("expected the control case to verify")
	}
}
