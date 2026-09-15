"""verify_grant_token accepts RS256 and ES256 from a JWK Set and nothing else.

Real signatures (PyJWT + cryptography) against a JWK Set served by a mocked
HTTP client: key selection by kid and key type, algorithm confusion and
header tampering.
"""
from __future__ import annotations

import base64
import json
import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from jwt.algorithms import ECAlgorithm, RSAAlgorithm

from grantex import GRANT_TOKEN_ALGORITHMS, GrantexTokenError, verify_grant_token
from grantex._types import VerifyGrantTokenOptions

ISSUER = "https://auth.example.com"
JWKS_URI = f"{ISSUER}/.well-known/jwks.json"

RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
EC_KEY = ec.generate_private_key(ec.SECP256R1())
P384_KEY = ec.generate_private_key(ec.SECP384R1())


def _public_jwk(key: Any, kid: str, alg: str | None) -> dict[str, Any]:
    if isinstance(key, rsa.RSAPrivateKey):
        jwk: dict[str, Any] = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    else:
        jwk = json.loads(ECAlgorithm.to_jwk(key.public_key()))
    jwk.update({"kid": kid, "use": "sig"})
    if alg is not None:
        jwk["alg"] = alg
    return jwk


RSA_JWK = _public_jwk(RSA_KEY, "rsa-1", "RS256")
EC_JWK = _public_jwk(EC_KEY, "ec-1", "ES256")


def _claims() -> dict[str, Any]:
    now = int(time.time())
    return {
        "iss": ISSUER,
        "sub": "user_alg",
        "agt": "did:grantex:ag_alg",
        "dev": "dev_alg",
        "scp": ["calendar:read"],
        "grnt": "grnt_alg",
        "jti": "tok_alg",
        "iat": now,
        "exp": now + 3600,
    }


def _sign(key: Any, alg: str, kid: str) -> str:
    return jwt.encode(_claims(), key, algorithm=alg, headers={"kid": kid, "typ": "at+jwt"})


def _with_header(token: str, header: dict[str, Any]) -> str:
    _, payload, signature = token.split(".")
    encoded = base64.urlsafe_b64encode(json.dumps(header).encode()).rstrip(b"=").decode()
    return f"{encoded}.{payload}.{signature}"


def _serve(mocker: Any, keys: list[dict[str, Any]]) -> None:
    response = mocker.Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"keys": keys}
    mocker.patch("grantex._verify.httpx.get", return_value=response)


def _verify(token: str, algorithms: list[str] | None = None) -> Any:
    return verify_grant_token(
        token, VerifyGrantTokenOptions(jwks_uri=JWKS_URI, algorithms=algorithms)
    )


def test_allowlist_is_exactly_rs256_and_es256() -> None:
    assert GRANT_TOKEN_ALGORITHMS == ("RS256", "ES256")


def test_es256_token_verifies_from_a_mixed_jwk_set(mocker: Any) -> None:
    _serve(mocker, [RSA_JWK, EC_JWK])
    grant = _verify(_sign(EC_KEY, "ES256", "ec-1"))
    assert grant.principal_id == "user_alg"
    assert grant.agent_did == "did:grantex:ag_alg"
    assert grant.grant_id == "grnt_alg"


def test_rs256_token_verifies_from_the_same_jwk_set(mocker: Any) -> None:
    _serve(mocker, [RSA_JWK, EC_JWK])
    assert _verify(_sign(RSA_KEY, "RS256", "rsa-1")).token_id == "tok_alg"


def test_es256_token_naming_the_rsa_key_is_rejected(mocker: Any) -> None:
    _serve(mocker, [RSA_JWK, EC_JWK])
    with pytest.raises(GrantexTokenError, match="No matching EC key"):
        _verify(_sign(EC_KEY, "ES256", "rsa-1"))


def test_rs256_token_naming_the_ec_key_is_rejected(mocker: Any) -> None:
    _serve(mocker, [RSA_JWK, EC_JWK])
    with pytest.raises(GrantexTokenError, match="No matching RSA key"):
        _verify(_sign(RSA_KEY, "RS256", "ec-1"))


def test_rs256_token_with_alg_header_changed_to_es256_is_rejected(mocker: Any) -> None:
    _serve(mocker, [RSA_JWK, EC_JWK])
    token = _sign(RSA_KEY, "RS256", "rsa-1")
    with pytest.raises(GrantexTokenError):
        _verify(_with_header(token, {"alg": "ES256", "kid": "rsa-1", "typ": "at+jwt"}))
    with pytest.raises(GrantexTokenError):
        _verify(_with_header(token, {"alg": "ES256", "kid": "ec-1", "typ": "at+jwt"}))


def test_es256_token_with_alg_header_changed_to_rs256_is_rejected(mocker: Any) -> None:
    _serve(mocker, [RSA_JWK, EC_JWK])
    token = _sign(EC_KEY, "ES256", "ec-1")
    with pytest.raises(GrantexTokenError):
        _verify(_with_header(token, {"alg": "RS256", "kid": "ec-1", "typ": "at+jwt"}))


def test_key_published_for_another_algorithm_is_not_used(mocker: Any) -> None:
    _serve(mocker, [{**EC_JWK, "alg": "RS256"}])
    with pytest.raises(GrantexTokenError, match="No matching EC key"):
        _verify(_sign(EC_KEY, "ES256", "ec-1"))


def test_es256_requires_a_p256_key(mocker: Any) -> None:
    _serve(mocker, [_public_jwk(P384_KEY, "ec-1", None)])
    with pytest.raises(GrantexTokenError, match="No matching EC key"):
        _verify(_sign(EC_KEY, "ES256", "ec-1"))


def test_key_with_non_signature_use_is_not_used(mocker: Any) -> None:
    _serve(mocker, [{**EC_JWK, "use": "enc"}])
    with pytest.raises(GrantexTokenError, match="No matching EC key"):
        _verify(_sign(EC_KEY, "ES256", "ec-1"))


def test_hs256_keyed_with_public_key_material_is_rejected(mocker: Any) -> None:
    _serve(mocker, [RSA_JWK])
    pem = RSA_KEY.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "kid": "rsa-1"}).encode()
    ).rstrip(b"=").decode()
    body = base64.urlsafe_b64encode(json.dumps(_claims()).encode()).rstrip(b"=").decode()
    import hashlib
    import hmac

    signature = base64.urlsafe_b64encode(
        hmac.new(pem, f"{header}.{body}".encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    with pytest.raises(GrantexTokenError, match="unsupported algorithm 'HS256'"):
        _verify(f"{header}.{body}.{signature}")


def test_alg_none_is_rejected(mocker: Any) -> None:
    _serve(mocker, [RSA_JWK])
    token = jwt.encode(_claims(), None, algorithm="none", headers={"kid": "rsa-1"})
    with pytest.raises(GrantexTokenError, match="unsupported algorithm 'none'"):
        _verify(token)


def test_unknown_kid_does_not_fall_back_to_another_key(mocker: Any) -> None:
    _serve(mocker, [EC_JWK])
    with pytest.raises(GrantexTokenError, match="kid='ec-rotated'"):
        _verify(_sign(EC_KEY, "ES256", "ec-rotated"))


def test_options_algorithms_narrows_the_allowlist(mocker: Any) -> None:
    _serve(mocker, [RSA_JWK, EC_JWK])
    token = _sign(EC_KEY, "ES256", "ec-1")
    with pytest.raises(GrantexTokenError, match="unsupported algorithm 'ES256'"):
        _verify(token, ["RS256"])
    assert _verify(token, ["ES256"]).token_id == "tok_alg"


@pytest.mark.parametrize(
    ("algorithms", "message"),
    [
        (["HS256"], "Unsupported grant token algorithm HS256"),
        (["none"], "Unsupported grant token algorithm none"),
        (["RS256", "PS256"], "Unsupported grant token algorithm PS256"),
        ([], "algorithms must list at least one of RS256, ES256"),
    ],
)
def test_options_algorithms_never_widens_the_allowlist(
    mocker: Any, algorithms: list[str], message: str
) -> None:
    _serve(mocker, [RSA_JWK])
    with pytest.raises(GrantexTokenError, match=message):
        _verify(_sign(RSA_KEY, "RS256", "rsa-1"), algorithms)
