package grantex

import "context"

// BillingService handles subscription and billing operations.
type BillingService struct {
	http *httpClient
}

// GetSubscription retrieves the current subscription status.
func (s *BillingService) GetSubscription(ctx context.Context) (*SubscriptionStatus, error) {
	return unmarshal[SubscriptionStatus](s.http.get(ctx, "/v1/billing/subscription"))
}

// CreateCheckout creates a checkout session for upgrading.
func (s *BillingService) CreateCheckout(ctx context.Context, params CreateCheckoutParams) (*CheckoutResponse, error) {
	return unmarshal[CheckoutResponse](s.http.post(ctx, "/v1/billing/checkout", params))
}

// CreatePortal creates a billing portal session.
func (s *BillingService) CreatePortal(ctx context.Context, params CreatePortalParams) (*PortalResponse, error) {
	return unmarshal[PortalResponse](s.http.post(ctx, "/v1/billing/portal", params))
}
