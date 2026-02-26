from __future__ import annotations

from .._http import HttpClient
from .._types import CheckoutResponse, CreateCheckoutParams, CreatePortalParams, PortalResponse, SubscriptionStatus


class BillingClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def get_subscription(self) -> SubscriptionStatus:
        """Return the current subscription status for the authenticated developer."""
        data = self._http.get("/v1/billing/subscription")
        return SubscriptionStatus.from_dict(data)

    def create_checkout(self, params: CreateCheckoutParams) -> CheckoutResponse:
        """Create a Stripe Checkout session and return the redirect URL."""
        data = self._http.post("/v1/billing/checkout", params.to_dict())
        return CheckoutResponse.from_dict(data)

    def create_portal(self, params: CreatePortalParams) -> PortalResponse:
        """Create a Stripe Billing Portal session and return the redirect URL."""
        data = self._http.post("/v1/billing/portal", params.to_dict())
        return PortalResponse.from_dict(data)
