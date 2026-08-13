package grantex

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"strconv"
	"time"
)

// WebhooksService handles webhook endpoint management.
type WebhooksService struct {
	http *httpClient
}

// Create registers a new webhook endpoint.
func (s *WebhooksService) Create(ctx context.Context, params CreateWebhookParams) (*WebhookEndpointWithSecret, error) {
	return unmarshal[WebhookEndpointWithSecret](s.http.post(ctx, "/v1/webhooks", params))
}

// List retrieves all webhook endpoints.
func (s *WebhooksService) List(ctx context.Context) (*ListWebhooksResponse, error) {
	return unmarshal[ListWebhooksResponse](s.http.get(ctx, "/v1/webhooks"))
}

// Delete removes a webhook endpoint.
func (s *WebhooksService) Delete(ctx context.Context, webhookID string) error {
	_, err := s.http.del(ctx, "/v1/webhooks/"+webhookID)
	return err
}

// DefaultWebhookToleranceSeconds bounds how old a delivery may be.
const DefaultWebhookToleranceSeconds = 300

// VerifyWebhookSignature verifies an HMAC-SHA256 webhook signature.
// The signature should be in "sha256=<hex>" format.
//
// Deprecated: this checks only that the body was signed with your secret. It
// commits to nothing time-bound, so a delivery captured once stays valid
// forever and can be replayed at will. Prefer VerifyWebhook, which binds the
// signature to a timestamp and rejects stale deliveries.
func VerifyWebhookSignature(payload []byte, signature string, secret string) bool {
	if len(signature) < 8 || signature[:7] != "sha256=" {
		return false
	}
	sigBytes, err := hex.DecodeString(signature[7:])
	if err != nil {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	expected := mac.Sum(nil)

	return subtle.ConstantTimeCompare(sigBytes, expected) == 1
}

// VerifyWebhook verifies a timestamped webhook delivery.
//
// It checks that the signature covers "<timestamp>.<payload>" and that the
// timestamp is recent. Both halves matter: without the signature the timestamp
// could be rewritten, and without the timestamp the signature never expires.
//
// signature is the X-Grantex-Signature-V2 header and timestamp the
// X-Grantex-Timestamp header. Pass the untouched request body; a body that has
// been parsed and re-serialized will not hash to the same value.
//
// toleranceSeconds bounds the delivery's age; pass
// DefaultWebhookToleranceSeconds for the standard window. Deliveries dated
// that far into the future are refused too, so a forged clock cannot buy an
// unbounded window.
func VerifyWebhook(payload []byte, signature, timestamp, secret string, toleranceSeconds int64) bool {
	if len(signature) < 8 || signature[:7] != "sha256=" {
		return false
	}
	sentAt, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || sentAt < 0 {
		return false
	}

	age := time.Now().Unix() - sentAt
	if age < 0 {
		age = -age
	}
	if age > toleranceSeconds {
		return false
	}

	sigBytes, err := hex.DecodeString(signature[7:])
	if err != nil {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(payload)
	expected := mac.Sum(nil)

	return subtle.ConstantTimeCompare(sigBytes, expected) == 1
}
