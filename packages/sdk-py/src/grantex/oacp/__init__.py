"""OACP artifact verification for relying parties (profile ``oacp-artifact-jws-v1``).

:func:`verify_oacp_artifact` checks an OACP envelope and payload: the
detached ES256 JWS over the RFC 8785 canonical envelope, the payload hash,
the pinned issuer key, the safety block, timestamps, TTL and scope, and the
Token Status List entry (draft-ietf-oauth-status-list), failing closed.

The TypeScript SDK mirrors it in ``verifyOacpArtifact``, the Go SDK in
``VerifyOacpArtifact``; all of them give the refusal codes in
``spec/examples/oacp/oacp-artifact-jws-v1.json``. Network sources are
asynchronous (``httpx.AsyncClient``) and bound to URLs the relying party
configures: :func:`create_oacp_jwks_fetcher` and
:func:`create_oacp_status_list_fetcher`.
"""

from __future__ import annotations

from ._fetchers import (
    OACP_FETCH_TIMEOUT_SECONDS,
    OACP_JWKS_CACHE_SECONDS,
    OACP_JWKS_MAX_BYTES,
    OACP_JWKS_REFRESH_COOLDOWN_SECONDS,
    OACP_STATUS_LIST_MAX_BYTES,
    OACP_STATUS_LIST_MAX_CACHE_SECONDS,
    OacpJwksFetcher,
    OacpJwksSource,
    OacpStatusListFetcher,
    OacpStatusListSource,
    create_oacp_jwks_fetcher,
    create_oacp_status_list_fetcher,
)
from ._status_list import (
    OACP_TOKEN_STATUS,
    STATUS_LIST_CLOCK_SKEW_SECONDS,
    STATUS_LIST_MAX_DECODED_BYTES,
    STATUS_LIST_TOKEN_MEDIA_TYPE,
    STATUS_LIST_TOKEN_TYP,
    DecodedOacpStatusList,
    OacpStatusListError,
    OacpStatusRead,
    OacpTokenStatus,
    decode_oacp_status_list,
    read_oacp_status,
)
from ._time import parse_oacp_timestamp
from ._verify import (
    OACP_ARTIFACT_JWS_TYP,
    OACP_ARTIFACT_MAX_TTL_SECONDS,
    OACP_FORBIDDEN_PAYLOAD_FIELDS,
    OACP_PROFILE,
    OACP_REFUSAL_CODES,
    OACP_SCOPE_MEMBERS,
    OACP_SIGNATURE_ALG,
    OacpVerification,
    verify_oacp_artifact,
)

__all__ = [
    "OACP_ARTIFACT_JWS_TYP",
    "OACP_ARTIFACT_MAX_TTL_SECONDS",
    "OACP_FETCH_TIMEOUT_SECONDS",
    "OACP_FORBIDDEN_PAYLOAD_FIELDS",
    "OACP_JWKS_CACHE_SECONDS",
    "OACP_JWKS_MAX_BYTES",
    "OACP_JWKS_REFRESH_COOLDOWN_SECONDS",
    "OACP_PROFILE",
    "OACP_REFUSAL_CODES",
    "OACP_SCOPE_MEMBERS",
    "OACP_SIGNATURE_ALG",
    "OACP_STATUS_LIST_MAX_BYTES",
    "OACP_STATUS_LIST_MAX_CACHE_SECONDS",
    "OACP_TOKEN_STATUS",
    "STATUS_LIST_CLOCK_SKEW_SECONDS",
    "STATUS_LIST_MAX_DECODED_BYTES",
    "STATUS_LIST_TOKEN_MEDIA_TYPE",
    "STATUS_LIST_TOKEN_TYP",
    "DecodedOacpStatusList",
    "OacpJwksFetcher",
    "OacpJwksSource",
    "OacpStatusListError",
    "OacpStatusListFetcher",
    "OacpStatusListSource",
    "OacpStatusRead",
    "OacpTokenStatus",
    "OacpVerification",
    "create_oacp_jwks_fetcher",
    "create_oacp_status_list_fetcher",
    "decode_oacp_status_list",
    "parse_oacp_timestamp",
    "read_oacp_status",
    "verify_oacp_artifact",
]
