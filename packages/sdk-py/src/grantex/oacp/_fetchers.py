"""Network sources for :func:`verify_oacp_artifact`.

The issuer's JWK Set and its Token Status Lists. Both are bound to URLs the
relying party configures; neither ever follows a URL taken from an artifact
outside those bounds, and neither follows redirects. All I/O is asynchronous
(``httpx.AsyncClient``).
"""

from __future__ import annotations

import asyncio
import base64
import json
import math
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Sequence, Union
from urllib.parse import SplitResult, unquote, urlsplit, urlunsplit

import httpx

from ._jose import JS_WHITESPACE
from ._status_list import STATUS_LIST_TOKEN_MEDIA_TYPE

__all__ = [
    "OACP_FETCH_TIMEOUT_SECONDS",
    "OACP_JWKS_CACHE_SECONDS",
    "OACP_JWKS_MAX_BYTES",
    "OACP_JWKS_REFRESH_COOLDOWN_SECONDS",
    "OACP_STATUS_LIST_MAX_BYTES",
    "OACP_STATUS_LIST_MAX_CACHE_SECONDS",
    "OacpJwksFetcher",
    "OacpJwksSource",
    "OacpStatusListFetcher",
    "OacpStatusListSource",
    "create_oacp_jwks_fetcher",
    "create_oacp_status_list_fetcher",
    "is_loopback_host",
    "normalize_https_url",
    "url_scheme_allowed",
]

#: Deadline for one fetch, headers and body, in seconds.
OACP_FETCH_TIMEOUT_SECONDS = 5.0
#: Largest JWK Set read, in bytes.
OACP_JWKS_MAX_BYTES = 64 * 1024
#: Largest Status List Token read, in bytes.
OACP_STATUS_LIST_MAX_BYTES = 1024 * 1024
#: The longest a JWK Set is reused before it is fetched again, in seconds.
OACP_JWKS_CACHE_SECONDS = 10 * 60
#: An unknown kid refetches the JWK Set at most this often, in seconds.
OACP_JWKS_REFRESH_COOLDOWN_SECONDS = 30
#: The longest a Status List Token is reused, whatever its ``ttl``, in seconds.
OACP_STATUS_LIST_MAX_CACHE_SECONDS = 600

#: The issuer's JWK Set, or an async callable returning it; ``refresh=True``
#: asks for a fresh copy (an unknown kid).
OacpJwksSource = Union[Mapping[str, Any], Callable[..., Awaitable[Mapping[str, Any]]]]

#: Returns the Status List Token text served at ``uri``. Raises when it cannot.
OacpStatusListSource = Callable[[str], Awaitable[str]]

_ACCEPT = "application/json, application/jwk-set+json, application/statuslist+jwt"
_LOOPBACK_V4 = re.compile(r"127(\.[0-9]{1,3}){3}", re.ASCII)


def is_loopback_host(hostname: str) -> bool:
    """``localhost``, 127.0.0.0/8 or ``::1``."""
    host = hostname
    if host.startswith("["):
        host = host[1:]
    if host.endswith("]"):
        host = host[:-1]
    host = host.lower()
    return host in ("localhost", "::1") or _LOOPBACK_V4.fullmatch(host) is not None


def _split(value: str) -> Optional[SplitResult]:
    if not isinstance(value, str):
        return None
    try:
        parts = urlsplit(value)
        _ = parts.port  # raises for a malformed port
    except ValueError:
        return None
    if not parts.hostname:
        return None
    return parts


def url_scheme_allowed(value: str, allow_loopback_http: bool) -> bool:
    """https, or http on a loopback host when ``allow_loopback_http`` is set."""
    parts = _split(value)
    if parts is None:
        return False
    if parts.scheme == "https":
        return True
    return allow_loopback_http and parts.scheme == "http" and is_loopback_host(parts.hostname or "")


def normalize_https_url(value: str, allow_loopback_http: bool, what: str) -> str:
    """The URL with a lower-case scheme and host, no default port and a ``/``
    path at least. Raises ``ValueError`` unless it is https (or loopback http
    when allowed)."""
    parts = _split(value)
    if parts is None:
        raise ValueError(f"{what} must be an https URL")
    if not url_scheme_allowed(value, allow_loopback_http):
        raise ValueError(f"{what} must be an https URL")
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    port = parts.port
    default = 443 if parts.scheme == "https" else 80
    netloc = host if port is None or port == default else f"{host}:{port}"
    userinfo = parts.netloc.rpartition("@")[0] if "@" in parts.netloc else ""
    if userinfo:
        netloc = f"{userinfo}@{netloc}"
    return urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, parts.fragment))


def _media_type(content_type: str) -> str:
    return content_type.split(";")[0].strip()


async def _bounded_text(
    client: Optional[httpx.AsyncClient],
    url: str,
    max_bytes: int,
    accept: Callable[[str], bool],
) -> str:
    async def read(active: httpx.AsyncClient) -> str:
        async with active.stream(
            "GET",
            url,
            headers={"accept": _ACCEPT, "accept-encoding": "identity"},
            follow_redirects=False,
            timeout=OACP_FETCH_TIMEOUT_SECONDS,
        ) as response:
            if response.status_code != 200:
                raise OSError(f"{url} answered HTTP {response.status_code}")
            if not accept(response.headers.get("content-type", "").lower()):
                raise OSError(f"{url} answered an unexpected content type")
            try:
                declared = int(response.headers.get("content-length", "0"))
            except ValueError:
                declared = 0
            if declared > max_bytes:
                raise OSError(f"{url} is larger than {max_bytes} bytes")
            chunks: List[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise OSError(f"{url} is larger than {max_bytes} bytes")
                chunks.append(chunk)
        # A WHATWG TextDecoder (fatal) drops one leading byte order mark; so does utf-8-sig.
        return b"".join(chunks).decode("utf-8-sig")

    async def run() -> str:
        if client is not None:
            return await read(client)
        async with httpx.AsyncClient(follow_redirects=False, timeout=OACP_FETCH_TIMEOUT_SECONDS) as owned:
            return await read(owned)

    try:
        return await asyncio.wait_for(run(), OACP_FETCH_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        raise OSError(f"{url} did not answer within {OACP_FETCH_TIMEOUT_SECONDS:g} s") from None


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


@dataclass
class _CachedJwks:
    jwks: Dict[str, Any]
    at: float


class OacpJwksFetcher:
    """A JWK Set source bound to the pinned issuer's JWKS URI.

    Cached for ten minutes, refetched for an unknown kid at most every 30
    seconds, HTTP 200 only, ``application/json`` or
    ``application/jwk-set+json``, at most 64 KiB, no redirects. Build one with
    :func:`create_oacp_jwks_fetcher`.
    """

    def __init__(self, jwks_uri: str, client: Optional[httpx.AsyncClient]) -> None:
        self.jwks_uri = jwks_uri
        self._client = client
        self._cached: Optional[_CachedJwks] = None

    async def __call__(self, refresh: bool = False) -> Dict[str, Any]:
        now = time.monotonic()
        cached = self._cached
        if cached is not None:
            age = now - cached.at
            fresh = age < OACP_JWKS_CACHE_SECONDS
            may_refresh = age >= OACP_JWKS_REFRESH_COOLDOWN_SECONDS
            if fresh and not (refresh is True and may_refresh):
                return cached.jwks
        text = await _bounded_text(
            self._client,
            self.jwks_uri,
            OACP_JWKS_MAX_BYTES,
            lambda content_type: _media_type(content_type) in ("application/json", "application/jwk-set+json"),
        )
        parsed = json.loads(text, parse_constant=_reject_constant)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("keys"), list):
            raise ValueError(f"{self.jwks_uri} is not a JWK Set")
        self._cached = _CachedJwks(jwks=parsed, at=now)
        return parsed


def create_oacp_jwks_fetcher(
    issuer: str,
    *,
    jwks_uri: Optional[str] = None,
    allow_loopback_http: bool = False,
    client: Optional[httpx.AsyncClient] = None,
) -> OacpJwksFetcher:
    """A JWK Set source for ``issuer`` (the auth service's ``JWT_ISSUER``).

    ``jwks_uri`` defaults to ``<issuer>/.well-known/jwks.json``. Plain http is
    accepted only on loopback hosts with ``allow_loopback_http`` (local
    development). ``client`` is used for the requests when given (its own
    redirect setting is overridden: redirects are never followed); otherwise
    each fetch opens a short-lived ``httpx.AsyncClient``.
    """
    allow = allow_loopback_http is True
    issuer_url = normalize_https_url(issuer, allow, "issuer")
    uri = normalize_https_url(
        jwks_uri if jwks_uri is not None else f"{issuer_url.rstrip('/')}/.well-known/jwks.json",
        allow,
        "jwks_uri",
    )
    return OacpJwksFetcher(uri, client)


def _unverified_ttl_seconds(token: str) -> Optional[int]:
    try:
        parts = token.split(".")
        segment = parts[1] if len(parts) > 1 else ""
        segment = re.sub(r"[^A-Za-z0-9_-]", "", segment)
        raw = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))
        claims = json.loads(raw.decode("utf-8", errors="replace"), parse_constant=_reject_constant)
        if not isinstance(claims, dict):
            return None
        ttl = claims.get("ttl")
        if isinstance(ttl, bool) or not isinstance(ttl, (int, float)):
            return None
        if not (math.isfinite(ttl) and float(ttl).is_integer() and 0 < ttl <= 2**53 - 1):
            return None
        ttl_s = int(ttl)
        exp = claims.get("exp")
        if not isinstance(exp, bool) and isinstance(exp, (int, float)) and math.isfinite(exp):
            return min(ttl_s, max(0, math.floor(exp - time.time())))
        return ttl_s
    except (ValueError, TypeError, OverflowError, RecursionError):
        return None


@dataclass
class _CachedToken:
    token: str
    until: float


class OacpStatusListFetcher:
    """A status-list source restricted to configured URI prefixes.

    It caches each list for no longer than the list's ``ttl``
    (draft-ietf-oauth-status-list §13.7) and never longer than
    ``max_cache_seconds``; the verifier still checks the signature and
    freshness of every copy, so a cached list never outlives its ``exp``.
    Build one with :func:`create_oacp_status_list_fetcher`.
    """

    def __init__(
        self,
        prefixes: Sequence[str],
        allow_loopback_http: bool,
        max_cache_seconds: float,
        client: Optional[httpx.AsyncClient],
    ) -> None:
        self.prefixes = tuple(prefixes)
        self._allow_loopback_http = allow_loopback_http
        self._max_cache_seconds = max_cache_seconds
        self._client = client
        self._cache: Dict[str, _CachedToken] = {}

    def clear(self) -> None:
        """Drops every cached list."""
        self._cache.clear()

    async def __call__(self, uri: str) -> str:
        url = normalize_https_url(uri, self._allow_loopback_http, "status list URI")
        if "?" in uri or "#" in uri or "@" in urlsplit(uri).netloc:
            raise ValueError("status list URI must not carry a query, fragment or credentials")
        # A dot segment (RFC 3986 §5.2.4, also percent-encoded) would let a URI
        # that starts with an allowed prefix resolve outside it.
        if any(segment in (".", "..") for segment in unquote(urlsplit(url).path).split("/")):
            raise ValueError("status list URI must not carry dot segments")
        if not any(url.startswith(prefix) for prefix in self.prefixes):
            raise ValueError("status list URI is outside the configured issuer prefixes")
        hit = self._cache.get(url)
        if hit is not None and hit.until > time.monotonic():
            return hit.token
        text = await _bounded_text(
            self._client,
            url,
            OACP_STATUS_LIST_MAX_BYTES,
            lambda content_type: _media_type(content_type) == STATUS_LIST_TOKEN_MEDIA_TYPE,
        )
        token = text.strip(JS_WHITESPACE)
        ttl = _unverified_ttl_seconds(token)
        if ttl is not None and self._max_cache_seconds > 0:
            self._cache[url] = _CachedToken(
                token=token, until=time.monotonic() + min(ttl, self._max_cache_seconds)
            )
        else:
            self._cache.pop(url, None)
        return token


def create_oacp_status_list_fetcher(
    allowed_prefixes: Sequence[str],
    *,
    allow_loopback_http: bool = False,
    max_cache_seconds: float = OACP_STATUS_LIST_MAX_CACHE_SECONDS,
    client: Optional[httpx.AsyncClient] = None,
) -> OacpStatusListFetcher:
    """A status-list source restricted to ``allowed_prefixes``.

    The prefixes are the URIs the relying party trusts to serve status lists,
    normally ``<issuer>/status/oacp/``; a status URI outside them, with a
    query, fragment or credentials, or not https (loopback http only with
    ``allow_loopback_http``) is refused. ``max_cache_seconds`` caps reuse
    (default 600 s; 0 disables reuse). ``client`` is used for the requests
    when given; otherwise each fetch opens a short-lived ``httpx.AsyncClient``.
    """
    if isinstance(allowed_prefixes, str):
        raise TypeError("allowed_prefixes must be a sequence of URI prefixes, not a string")
    allow = allow_loopback_http is True
    prefixes = [normalize_https_url(prefix, allow, "allowed prefix") for prefix in allowed_prefixes]
    if not prefixes:
        raise ValueError("create_oacp_status_list_fetcher needs at least one allowed prefix")
    return OacpStatusListFetcher(prefixes, allow, max_cache_seconds, client)
