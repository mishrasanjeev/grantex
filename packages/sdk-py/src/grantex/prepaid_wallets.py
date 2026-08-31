from __future__ import annotations

import base64
import hashlib
import ipaddress
import time
import uuid
from typing import Any, List
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import ec

from ._errors import GrantexApiError, GrantexAuthError
from ._http import HttpClient

WalletRecord = dict[str, Any]


class WalletSpendPoliciesClient:
    """Developer API-key access to organization-wide wallet spend policy."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, params: WalletRecord) -> WalletRecord:
        return _record(self._http.post("/v1/prepaid-wallet-spend-policies", params))

    def list(self) -> list[WalletRecord]:
        data = _record(self._http.get("/v1/prepaid-wallet-spend-policies"))
        return _records(data.get("policies"))

    def set_status(self, policy_id: str, status: str) -> WalletRecord:
        return _record(
            self._http.patch(
                f"/v1/prepaid-wallet-spend-policies/{quote(policy_id, safe='')}/status",
                {"status": status},
            )
        )


class PrincipalPrepaidWalletClient:
    """Principal-session wallet, assignment, reload, policy, and approval client."""

    def __init__(
        self,
        *,
        base_url: str,
        session_token: str,
        timeout: float = 30.0,
        client: httpx.Client | None = None,
    ) -> None:
        if not session_token.strip():
            raise ValueError("session_token is required")
        self._base_url = _base_url(base_url)
        self._session_token = session_token.strip()
        self._client = client or httpx.Client(timeout=timeout)
        self._owns_client = client is None

    def set_session_token(self, session_token: str) -> None:
        if not session_token.strip():
            raise ValueError("session_token is required")
        self._session_token = session_token.strip()

    def create(self, params: WalletRecord) -> WalletRecord:
        return self._request("POST", "/v1/principal/prepaid-wallets", params)

    def list(self) -> list[WalletRecord]:
        return _records(
            self._request("GET", "/v1/principal/prepaid-wallets").get("wallets")
        )

    def activity(self, wallet_id: str) -> WalletRecord:
        return self._request(
            "GET", f"/v1/principal/prepaid-wallets/{quote(wallet_id, safe='')}/activity"
        )

    def assign(self, wallet_id: str, params: WalletRecord) -> WalletRecord:
        return self._request(
            "POST",
            f"/v1/principal/prepaid-wallets/{quote(wallet_id, safe='')}/assignments",
            params,
        )

    def set_assignment_status(
        self, assignment_id: str, status: str, reason: str | None = None
    ) -> WalletRecord:
        return self._request(
            "PATCH",
            f"/v1/principal/prepaid-wallet-assignments/{quote(assignment_id, safe='')}",
            _with_reason(status=status, reason=reason),
        )

    def set_wallet_status(
        self, wallet_id: str, status: str, reason: str | None = None
    ) -> WalletRecord:
        return self._request(
            "PATCH",
            f"/v1/principal/prepaid-wallets/{quote(wallet_id, safe='')}/status",
            _with_reason(status=status, reason=reason),
        )

    def set_agent_blocked(
        self, agent_id: str, blocked: bool, reason: str | None = None
    ) -> WalletRecord:
        body: WalletRecord = {"blocked": blocked}
        if reason is not None:
            body["reason"] = reason
        return self._request(
            "PUT",
            f"/v1/principal/prepaid-wallet-agents/{quote(agent_id, safe='')}/block",
            body,
        )

    def reload(
        self,
        wallet_id: str,
        amount: str,
        idempotency_key: str,
        external_reference: str | None = None,
    ) -> WalletRecord:
        body: WalletRecord = {"amount": amount, "idempotencyKey": idempotency_key}
        if external_reference is not None:
            body["externalReference"] = external_reference
        return self._request(
            "POST",
            f"/v1/principal/prepaid-wallets/{quote(wallet_id, safe='')}/reloads",
            body,
        )

    def decide_reload(self, request_id: str, decision: str) -> WalletRecord:
        return self._request(
            "POST",
            f"/v1/principal/prepaid-wallet-reload-requests/{quote(request_id, safe='')}/decision",
            {"decision": decision},
        )

    def fund_reload(
        self, request_id: str, external_reference: str | None = None
    ) -> WalletRecord:
        body: WalletRecord = {}
        if external_reference is not None:
            body["externalReference"] = external_reference
        return self._request(
            "POST",
            f"/v1/principal/prepaid-wallet-reload-requests/{quote(request_id, safe='')}/fund",
            body,
        )

    def release_reservation(self, reservation_id: str, reason: str) -> WalletRecord:
        return self._request(
            "POST",
            f"/v1/principal/prepaid-wallet-reservations/{quote(reservation_id, safe='')}/release",
            {"reason": reason},
        )

    def create_spend_policy(self, params: WalletRecord) -> WalletRecord:
        return self._request(
            "POST", "/v1/principal/prepaid-wallet-spend-policies", params
        )

    def list_spend_policies(self) -> List[WalletRecord]:
        return _records(
            self._request("GET", "/v1/principal/prepaid-wallet-spend-policies").get(
                "policies"
            )
        )

    def set_spend_policy_status(self, policy_id: str, status: str) -> WalletRecord:
        return self._request(
            "PATCH",
            f"/v1/principal/prepaid-wallet-spend-policies/{quote(policy_id, safe='')}/status",
            {"status": status},
        )

    def list_payment_approvals(self) -> List[WalletRecord]:
        return _records(
            self._request("GET", "/v1/principal/prepaid-wallet-payment-approvals").get(
                "approvals"
            )
        )

    def decide_payment_approval(
        self, approval_request_id: str, decision: str, reason: str | None = None
    ) -> WalletRecord:
        return self._request(
            "POST",
            f"/v1/principal/prepaid-wallet-payment-approvals/{quote(approval_request_id, safe='')}/decision",
            _with_reason(decision=decision, reason=reason),
        )

    def _request(
        self, method: str, path: str, body: WalletRecord | None = None
    ) -> WalletRecord:
        response = self._client.request(
            method,
            f"{self._base_url}{path}",
            headers={
                "Authorization": f"Bearer {self._session_token}",
                "Accept": "application/json",
            },
            json=body,
        )
        return _wallet_response(response)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> PrincipalPrepaidWalletClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


class AgentPrepaidWalletClient:
    """DPoP-bound agent wallet client using an ES256 OAuth token key."""

    def __init__(
        self,
        *,
        access_token: str,
        private_key: ec.EllipticCurvePrivateKey,
        resource_url: str,
        timeout: float = 30.0,
        client: httpx.Client | None = None,
    ) -> None:
        if not access_token:
            raise ValueError("access_token is required")
        resource = _base_url(resource_url)
        if not resource.endswith("/v1/prepaid-wallets"):
            raise ValueError("resource_url must end with /v1/prepaid-wallets")
        if not isinstance(private_key.curve, ec.SECP256R1):
            raise ValueError("private_key must use P-256 for ES256 DPoP")
        self._access_token = access_token
        self._private_key = private_key
        self._resource_url = resource
        self._client = client or httpx.Client(timeout=timeout)
        self._owns_client = client is None

    def set_access_token(self, access_token: str) -> None:
        if not access_token:
            raise ValueError("access_token is required")
        self._access_token = access_token

    def list(self) -> list[WalletRecord]:
        return _records(self._request("GET", self._resource_url).get("wallets"))

    def authorize_payment(self, params: WalletRecord) -> WalletRecord:
        return self._request("POST", f"{self._resource_url}/authorizations", params)

    def request_reload(
        self,
        wallet_id: str,
        amount: str,
        idempotency_key: str,
        reason: str | None = None,
    ) -> WalletRecord:
        body: WalletRecord = {"amount": amount, "idempotencyKey": idempotency_key}
        if reason is not None:
            body["reason"] = reason
        return self._request(
            "POST",
            f"{self._resource_url}/{quote(wallet_id, safe='')}/reload-requests",
            body,
        )

    def _request(
        self, method: str, url: str, body: WalletRecord | None = None
    ) -> WalletRecord:
        proof = _dpop_proof(method, url, self._access_token, self._private_key)
        response = self._client.request(
            method,
            url,
            headers={
                "Authorization": f"DPoP {self._access_token}",
                "DPoP": proof,
                "Accept": "application/json",
            },
            json=body,
        )
        return _wallet_response(response)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> AgentPrepaidWalletClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def generate_dpop_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


def _dpop_proof(
    method: str, url: str, access_token: str, key: ec.EllipticCurvePrivateKey
) -> str:
    public = key.public_key().public_numbers()
    jwk = {
        "kty": "EC",
        "crv": "P-256",
        "x": _b64(public.x.to_bytes(32, "big")),
        "y": _b64(public.y.to_bytes(32, "big")),
    }
    claims = {
        "htm": method.upper(),
        "htu": url,
        "iat": int(time.time()),
        "jti": str(uuid.uuid4()),
        "ath": _b64(hashlib.sha256(access_token.encode("utf-8")).digest()),
    }
    return str(
        jwt.encode(
            claims, key, algorithm="ES256", headers={"typ": "dpop+jwt", "jwk": jwk}
        )
    )


def _wallet_response(response: httpx.Response) -> WalletRecord:
    try:
        body: Any = response.json()
    except Exception:
        body = None
    if not response.is_success:
        message = (
            body.get("message")
            if isinstance(body, dict)
            else f"HTTP {response.status_code}"
        )
        code = body.get("code") if isinstance(body, dict) else None
        request_id = (
            body.get("requestId")
            if isinstance(body, dict)
            else response.headers.get("x-request-id")
        )
        error = GrantexApiError(
            str(message), response.status_code, body, request_id, code
        )
        if response.status_code in (401, 403):
            raise GrantexAuthError(
                str(message), response.status_code, body, request_id, code
            )
        raise error
    return _record(body)


def _record(value: Any) -> WalletRecord:
    if not isinstance(value, dict):
        raise ValueError("Grantex wallet API returned a non-object response")
    return {str(key): item for key, item in value.items()}


def _records(value: Any) -> list[WalletRecord]:
    if not isinstance(value, list):
        raise ValueError("Grantex wallet API returned a non-list collection")
    return [_record(item) for item in value]


def _with_reason(*, reason: str | None, **values: Any) -> WalletRecord:
    result: WalletRecord = dict(values)
    if reason is not None:
        result["reason"] = reason
    return result


def _base_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.netloc
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "base URL must be an absolute HTTP(S) URL without query or fragment"
        )
    if parsed.username or parsed.password:
        raise ValueError("base URL must not contain credentials")
    host = parsed.hostname or ""
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host.lower() == "localhost"
    if parsed.scheme == "http" and not loopback:
        raise ValueError("remote wallet endpoints must use HTTPS")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
