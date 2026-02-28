package grantex

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
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

// VerifyWebhookSignature verifies an HMAC-SHA256 webhook signature.
// The signature should be in "sha256=<hex>" format.
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
