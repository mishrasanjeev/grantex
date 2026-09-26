from __future__ import annotations

from urllib.parse import quote

from .._http import HttpClient
from .._types import (
    WebAuthnRegistrationOptions,
    WebAuthnRegistrationVerifyParams,
    WebAuthnCredential,
    ListWebAuthnCredentialsResponse,
    WebAuthnEnrollmentSession,
)


class WebAuthnClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create_enrollment_session(
        self, *, principal_id: str, auth_request_id: str | None = None
    ) -> WebAuthnEnrollmentSession:
        """Issue a one-use link after authenticating the principal in your application."""
        body = {"principalId": principal_id}
        if auth_request_id is not None:
            body["authRequestId"] = auth_request_id
        data = self._http.post("/v1/webauthn/enrollment-sessions", body)
        return WebAuthnEnrollmentSession.from_dict(data)

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
        data = self._http.get(
            f"/v1/webauthn/credentials?principalId={quote(principal_id, safe='')}"
        )
        return ListWebAuthnCredentialsResponse.from_dict(data)

    def delete_credential(self, credential_id: str) -> None:
        self._http.delete(f"/v1/webauthn/credentials/{quote(credential_id, safe='')}")
