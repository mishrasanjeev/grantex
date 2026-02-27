from __future__ import annotations

import os

from ._http import HttpClient
from ._types import AuthorizationRequest, AuthorizeParams
from .resources._agents import AgentsClient
from .resources._audit import AuditClient
from .resources._anomalies import AnomaliesClient
from .resources._compliance import ComplianceClient
from .resources._grants import GrantsClient
from .resources._tokens import TokensClient
from .resources._webhooks import WebhooksClient
from .resources._billing import BillingClient
from .resources._policies import PoliciesClient

_DEFAULT_BASE_URL = "https://api.grantex.dev"


class Grantex:
    """Main entry point for the Grantex SDK."""

    agents: AgentsClient
    grants: GrantsClient
    tokens: TokensClient
    audit: AuditClient
    webhooks: WebhooksClient
    billing: BillingClient
    policies: PoliciesClient
    compliance: ComplianceClient
    anomalies: AnomaliesClient

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = 30.0,
    ) -> None:
        resolved_key = api_key or os.environ.get("GRANTEX_API_KEY", "")
        if not resolved_key:
            raise ValueError(
                "Grantex API key is required. Pass `api_key` or set the "
                "GRANTEX_API_KEY environment variable."
            )

        self._http = HttpClient(
            base_url=base_url,
            api_key=resolved_key,
            timeout=timeout,
        )

        self.agents = AgentsClient(self._http)
        self.grants = GrantsClient(self._http)
        self.tokens = TokensClient(self._http)
        self.audit = AuditClient(self._http)
        self.webhooks = WebhooksClient(self._http)
        self.billing = BillingClient(self._http)
        self.policies = PoliciesClient(self._http)
        self.compliance = ComplianceClient(self._http)
        self.anomalies = AnomaliesClient(self._http)

    def authorize(self, params: AuthorizeParams) -> AuthorizationRequest:
        """Initiate the delegated authorization flow for a user.

        `user_id` is transparently mapped to `principalId` in the request body.
        """
        data = self._http.post("/v1/authorize", params.to_dict())
        return AuthorizationRequest.from_dict(data)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Grantex:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
