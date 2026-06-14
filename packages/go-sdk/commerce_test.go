package grantex

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

const commerceTestMerchantID = "mch_shopify_mgx0n6_22"

func TestCommerceGetProfile(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/grantex-commerce" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if got := r.URL.Query().Get("merchant_id"); got != commerceTestMerchantID {
			t.Errorf("expected merchant_id %s, got %s", commerceTestMerchantID, got)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(CommerceProfile{
			Version: "grantex-commerce-v1",
			Merchant: CommerceRecord{
				"merchant_id": commerceTestMerchantID,
			},
			SupportedTools: []string{"catalog.search"},
			Capabilities: []CommerceRecord{
				{"name": "catalog.search"},
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	profile, err := client.Commerce.GetProfile(context.Background(), commerceTestMerchantID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if profile.Merchant["merchant_id"] != commerceTestMerchantID {
		t.Errorf("unexpected merchant_id: %v", profile.Merchant["merchant_id"])
	}
	if len(profile.SupportedTools) != 1 || profile.SupportedTools[0] != "catalog.search" {
		t.Errorf("unexpected supported tools: %#v", profile.SupportedTools)
	}
}

func TestCommerceSearchCatalog(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/commerce/catalog/search" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body CommerceRecord
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode request body: %v", err)
		}
		if body["merchant_id"] != commerceTestMerchantID {
			t.Errorf("unexpected merchant_id: %v", body["merchant_id"])
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(CommerceListResponse{
			Items: []CommerceRecord{{"product_id": "prod_1"}},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Commerce.SearchCatalog(context.Background(), CommerceRecord{
		"merchant_id": commerceTestMerchantID,
		"query":       "lamp",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result.Items) != 1 || result.Items[0]["product_id"] != "prod_1" {
		t.Errorf("unexpected items: %#v", result.Items)
	}
}

func TestCommerceCreateCartSendsIdempotencyHeader(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/commerce/carts" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Idempotency-Key"); got != "idem-cart-1" {
			t.Errorf("expected idempotency header, got %s", got)
		}
		var body CommerceRecord
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode request body: %v", err)
		}
		if _, ok := body["idempotencyKey"]; ok {
			t.Error("idempotencyKey must not be sent in JSON body")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(CommerceDataResponse{
			Data: CommerceRecord{"cart_id": "cart_1"},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	_, err := client.Commerce.CreateCart(context.Background(), CommerceRecord{
		"merchant_id": commerceTestMerchantID,
		"currency":    "INR",
		"line_items":  []CommerceRecord{},
	}, "idem-cart-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCommerceNestedWebhookErrorEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webhooks/providers/plural" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": map[string]string{
				"code":    "webhook_signature_invalid",
				"message": "Plural webhook signature headers are missing",
			},
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL), WithMaxRetries(0))
	_, err := client.Commerce.HandleProviderWebhook(context.Background(), "plural", CommerceRecord{}, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	var authErr *AuthError
	if !errors.As(err, &authErr) {
		t.Fatalf("expected AuthError, got %T", err)
	}
	if authErr.Code != "webhook_signature_invalid" {
		t.Errorf("expected nested code, got %s", authErr.Code)
	}
	if authErr.Message != "Plural webhook signature headers are missing" {
		t.Errorf("unexpected message: %s", authErr.Message)
	}
}
