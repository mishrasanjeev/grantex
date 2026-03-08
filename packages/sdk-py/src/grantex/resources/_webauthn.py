from __future__ import annotations

from .._http import HttpClient
from .._types import (
    WebAuthnRegistrationOptions,
    WebAuthnRegistrationVerifyParams,
    WebAuthnCredential,
    ListWebAuthnCredentialsResponse,
)


class WebAuthnClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def register_options(self, *, principal_id: str) -> WebAuthnRegistrationOptions:
        data = self._http.post(
            "/v1/webauthn/register/options",
            {"principalId": principal_id},
        )
        return WebAuthnRegistrationOptions.from_dict(data)

    def register_verify(
        self, params: WebAuthnRegistrationVerifyParams
    ) -> WebAuthnCredential:
        data = self._http.post("/v1/webauthn/register/verify", params.to_dict())
        return WebAuthnCredential.from_dict(data)

    def list_credentials(self, principal_id: str) -> ListWebAuthnCredentialsResponse:
        from urllib.parse import quote

        data = self._http.get(
            f"/v1/webauthn/credentials?principalId={quote(principal_id, safe='')}"
        )
        return ListWebAuthnCredentialsResponse.from_dict(data)

    def delete_credential(self, credential_id: str) -> None:
        self._http.delete(f"/v1/webauthn/credentials/{credential_id}")
