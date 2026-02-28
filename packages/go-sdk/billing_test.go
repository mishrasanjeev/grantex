package grantex

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBillingGetSubscription(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing/subscription" || r.Method != http.MethodGet {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		periodEnd := "2026-04-01T00:00:00Z"
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(SubscriptionStatus{
			Plan:             "pro",
			Status:           "active",
			CurrentPeriodEnd: &periodEnd,
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	sub, err := client.Billing.GetSubscription(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sub.Plan != "pro" {
		t.Errorf("expected pro, got %s", sub.Plan)
	}
	if sub.Status != "active" {
		t.Errorf("expected active, got %s", sub.Status)
	}
}

func TestBillingCreateCheckout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing/checkout" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(CheckoutResponse{
			CheckoutURL: "https://checkout.stripe.com/session-123",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Billing.CreateCheckout(context.Background(), CreateCheckoutParams{
		Plan:       "pro",
		SuccessURL: "https://example.com/success",
		CancelURL:  "https://example.com/cancel",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.CheckoutURL != "https://checkout.stripe.com/session-123" {
		t.Errorf("unexpected checkout URL: %s", result.CheckoutURL)
	}
}

func TestBillingCreatePortal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing/portal" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(PortalResponse{
			PortalURL: "https://billing.stripe.com/portal-123",
		})
	}))
	defer server.Close()

	client := NewClient("test-key", WithBaseURL(server.URL))
	result, err := client.Billing.CreatePortal(context.Background(), CreatePortalParams{
		ReturnURL: "https://example.com/dashboard",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.PortalURL != "https://billing.stripe.com/portal-123" {
		t.Errorf("unexpected portal URL: %s", result.PortalURL)
	}
}
