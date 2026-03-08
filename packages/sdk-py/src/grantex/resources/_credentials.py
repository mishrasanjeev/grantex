from __future__ import annotations

from .._http import HttpClient
from .._types import (
    VerifiableCredentialRecord,
    ListCredentialsParams,
    ListCredentialsResponse,
    VCVerificationResult,
    SDJWTPresentParams,
    SDJWTPresentResult,
)


class CredentialsClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def get(self, credential_id: str) -> VerifiableCredentialRecord:
        data = self._http.get(f"/v1/credentials/{credential_id}")
        return VerifiableCredentialRecord.from_dict(data)

    def list(
        self, params: ListCredentialsParams | None = None
    ) -> ListCredentialsResponse:
        path = "/v1/credentials"
        if params is not None:
            query = params.to_query()
            if query:
                from urllib.parse import urlencode

                path = f"{path}?{urlencode(query)}"
        data = self._http.get(path)
        return ListCredentialsResponse.from_dict(data)

    def verify(self, vc_jwt: str) -> VCVerificationResult:
        data = self._http.post("/v1/credentials/verify", {"credential": vc_jwt})
        return VCVerificationResult.from_dict(data)

    def present(self, params: SDJWTPresentParams) -> SDJWTPresentResult:
        data = self._http.post("/v1/credentials/present", params.to_dict())
        return SDJWTPresentResult.from_dict(data)
