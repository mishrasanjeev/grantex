from __future__ import annotations

from .._http import HttpClient
from .._types import (
    CreatePolicyParams,
    ListPoliciesResponse,
    Policy,
    UpdatePolicyParams,
)


class PoliciesClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, params: CreatePolicyParams) -> Policy:
        """Create a new policy."""
        data = self._http.post("/v1/policies", params.to_dict())
        return Policy.from_dict(data)

    def list(self) -> ListPoliciesResponse:
        """List all policies for the authenticated developer."""
        data = self._http.get("/v1/policies")
        return ListPoliciesResponse.from_dict(data)

    def get(self, policy_id: str) -> Policy:
        """Get a single policy by ID."""
        data = self._http.get(f"/v1/policies/{policy_id}")
        return Policy.from_dict(data)

    def update(self, policy_id: str, params: UpdatePolicyParams) -> Policy:
        """Update a policy."""
        data = self._http.patch(f"/v1/policies/{policy_id}", params.to_dict())
        return Policy.from_dict(data)

    def delete(self, policy_id: str) -> None:
        """Delete a policy."""
        self._http.delete(f"/v1/policies/{policy_id}")
