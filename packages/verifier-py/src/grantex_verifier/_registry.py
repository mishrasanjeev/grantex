# SPDX-License-Identifier: Apache-2.0
"""What the relying party reads from the registry and the issuers, and how long it keeps it.

Every document is read through the injected ``fetch`` and kept no longer
than the staleness matrix allows (``_staleness``). Nothing here falls back to
a copy beyond its bound: a source that cannot be read again is refused with
``status_stale``.

The manifest check mirrors ``verifyRegistryManifest`` in
``apps/auth-service/src/lib/registry/manifest.ts``: exact ``typ``
``grantex-registry-manifest+jwt``, ``RS256`` or ``ES256``, the key from the
registry's JWK Set by ``kid`` and none named in the header, no ``crit``, the
members, ``iss`` equal to the registry the relying party configured, and
freshness (before ``exp``, a lifetime of at most an hour, issued at most an
hour ago and not in the future beyond 60 seconds).
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from ._codes import PASSPORT_INVALID_SIGNATURE, STATUS_STALE, Refusal
from ._jose import JoseError, check_header, jwk_set_keys, parse, verify_with_keys
from ._staleness import (
    LOOKUP_MAX_AGE_SECONDS,
    MANIFEST_MAX_AGE_SECONDS,
    MANIFEST_REFRESH_SECONDS,
    REGISTRY_KEYS_MAX_AGE_SECONDS,
)
from ._status_list import StatusListToken, read_status_list

REGISTRY_MANIFEST_TYP = "grantex-registry-manifest+jwt"
#: The platform's signing algorithms (apps/auth-service/src/lib/signing-algorithms.ts).
REGISTRY_ALGORITHMS = ("RS256", "ES256")
MANIFEST_CLOCK_TOLERANCE_SECONDS = 60
#: A registry key set is refetched early, at most this often, when a kid is unknown.
KEYS_EARLY_REFRESH_SECONDS = 300

Fetcher = Callable[[str], Union[str, bytes]]
RegistryLookup = Callable[[str], Optional[Mapping[str, Any]]]


def _text(body: Union[str, bytes]) -> str:
    if isinstance(body, bytes):
        return body.decode("utf-8")
    if isinstance(body, str):
        return body
    raise TypeError("fetch must return str or bytes")


def verify_manifest(
    token: str, keys: Sequence[Mapping[str, Any]], now: float, issuer: str
) -> Dict[str, Any]:
    """Verify a registry manifest and return its claims, or raise Refusal."""
    if not isinstance(issuer, str) or issuer == "":
        # As in manifest.ts, the expected issuer is required, never defaulted.
        raise Refusal(PASSPORT_INVALID_SIGNATURE, "manifest: no registry issuer is configured")
    try:
        jws = parse(token)
        alg = check_header(jws.header, REGISTRY_MANIFEST_TYP, REGISTRY_ALGORITHMS)
        verify_with_keys(jws, alg, keys)
    except JoseError as cause:
        raise Refusal(PASSPORT_INVALID_SIGNATURE, "manifest: " + str(cause)) from cause
    claims = jws.payload
    iss, iat, exp = claims.get("iss"), claims.get("iat"), claims.get("exp")
    issuers = claims.get("issuers")
    if (
        not isinstance(iss, str)
        or not isinstance(iat, int)
        or not isinstance(exp, int)
        or isinstance(iat, bool)
        or isinstance(exp, bool)
        or not isinstance(issuers, list)
        or not isinstance(claims.get("trust_mark_types"), list)
        or not isinstance(claims.get("acceptance_status_lists"), list)
        or not isinstance(claims.get("endpoints"), dict)
    ):
        raise Refusal(PASSPORT_INVALID_SIGNATURE, "manifest: members are missing or malformed")
    for entry in issuers:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("entity_id"), str)
            or not isinstance(entry.get("status"), str)
            or not isinstance(entry.get("trust_marks"), list)
            or not isinstance(entry.get("status_list_base"), str)
            or jwk_set_keys(entry.get("jwks")) is None
        ):
            raise Refusal(PASSPORT_INVALID_SIGNATURE, "manifest: an issuer entry is malformed")
    if iss != issuer:
        raise Refusal(PASSPORT_INVALID_SIGNATURE, "manifest: iss is not the configured registry")
    if exp <= iat or exp - iat > MANIFEST_MAX_AGE_SECONDS:
        raise Refusal(STATUS_STALE, "manifest: lifetime is not within one hour")
    if iat > now + MANIFEST_CLOCK_TOLERANCE_SECONDS:
        raise Refusal(STATUS_STALE, "manifest: iat is in the future")
    if now >= exp:
        raise Refusal(STATUS_STALE, "manifest: expired")
    if now - iat > MANIFEST_MAX_AGE_SECONDS:
        raise Refusal(STATUS_STALE, "manifest: more than an hour old")
    return claims


def manifest_still_fresh(claims: Mapping[str, Any], now: float) -> bool:
    iat, exp = claims["iat"], claims["exp"]
    return bool(now < exp and now - iat <= MANIFEST_MAX_AGE_SECONDS and iat <= now + MANIFEST_CLOCK_TOLERANCE_SECONDS)


@dataclass
class _Cached:
    value: Any
    fetched_at: float


class RegistrySource:
    """The registry's and issuers' documents with their read times. Thread-safe."""

    def __init__(
        self,
        *,
        registry_issuer: str,
        registry_jwks: Union[str, Mapping[str, Any]],
        manifest_url: str,
        fetch: Fetcher,
        lookup: RegistryLookup,
    ) -> None:
        static = None
        if not isinstance(registry_jwks, str):
            static = jwk_set_keys(registry_jwks)
            if static is None:
                raise ValueError("registry_jwks must be a JWK Set or its URL")
        self.registry_issuer = registry_issuer
        self._static_keys: Optional[List[Mapping[str, Any]]] = list(static) if static is not None else None
        self._jwks_url = registry_jwks if isinstance(registry_jwks, str) else None
        self._manifest_url = manifest_url
        self._fetch = fetch
        self._lookup = lookup
        self._lock = threading.Lock()
        self._keys: Optional[_Cached] = None
        self._manifest: Optional[_Cached] = None
        self._lists: Dict[str, _Cached] = {}
        self._lookups: Dict[str, _Cached] = {}

    # ── registry keys (24 h) ────────────────────────────────────────────────

    def _fetch_keys(self, now: float) -> _Cached:
        assert self._jwks_url is not None
        try:
            keys = jwk_set_keys(json.loads(_text(self._fetch(self._jwks_url))))
        except Exception as cause:
            # Fail closed: without the registry's keys nothing it signed can be
            # trusted. The cause is chained for the operator.
            raise Refusal(STATUS_STALE, "registry keys could not be read") from cause
        if keys is None:
            raise Refusal(STATUS_STALE, "registry keys are not a JWK Set")
        cached = _Cached(list(keys), now)
        with self._lock:
            self._keys = cached
        return cached

    def registry_keys(self, now: float) -> Tuple[List[Mapping[str, Any]], Optional[float]]:
        if self._static_keys is not None:
            return self._static_keys, None
        with self._lock:
            cached = self._keys
        if cached is None or now - cached.fetched_at > REGISTRY_KEYS_MAX_AGE_SECONDS:
            cached = self._fetch_keys(now)
        return cached.value, cached.fetched_at

    def verify_registry_jws(self, token: str, typ: str, now: float) -> Tuple[Dict[str, Any], Optional[float]]:
        """Verify a token the registry signed; raises JoseError or Refusal."""
        jws = parse(token)
        alg = check_header(jws.header, typ, REGISTRY_ALGORITHMS)
        keys, fetched_at = self.registry_keys(now)
        try:
            verify_with_keys(jws, alg, keys)
        except JoseError as error:
            # A kid the cached set does not have may be a new registry key:
            # read the set again (at most every five minutes) and retry once.
            if (
                error.reason != "key_not_found"
                or fetched_at is None
                or now - fetched_at < KEYS_EARLY_REFRESH_SECONDS
            ):
                raise
            refreshed = self._fetch_keys(now)
            verify_with_keys(jws, alg, refreshed.value)
            fetched_at = refreshed.fetched_at
        return jws.payload, fetched_at

    # ── the manifest (1 h) ──────────────────────────────────────────────────

    def manifest(self, now: float) -> Tuple[Dict[str, Any], float]:
        with self._lock:
            cached = self._manifest
        if cached is not None and now - cached.fetched_at < MANIFEST_REFRESH_SECONDS and manifest_still_fresh(
            cached.value, now
        ):
            return cached.value, cached.fetched_at
        try:
            token = _text(self._fetch(self._manifest_url))
        except Exception as cause:
            # A copy still inside its hour may be used while the registry
            # cannot be reached; past it, fail closed (never an expired copy).
            if cached is not None and manifest_still_fresh(cached.value, now):
                return cached.value, cached.fetched_at
            raise Refusal(STATUS_STALE, "manifest could not be read") from cause
        keys, _ = self.registry_keys(now)
        try:
            claims = verify_manifest(token, keys, now, self.registry_issuer)
        except Refusal as refusal:
            if refusal.code != PASSPORT_INVALID_SIGNATURE or "key_not_found" not in _reason(refusal):
                raise
            # The manifest names a registry key the cached set lacks: reread once.
            with self._lock:
                self._keys = None
            keys, _ = self.registry_keys(now)
            claims = verify_manifest(token, keys, now, self.registry_issuer)
        fresh = _Cached(claims, now)
        with self._lock:
            self._manifest = fresh
        return claims, now

    # ── status lists (ttl, at most the bound) ───────────────────────────────

    def status_list(
        self,
        uri: str,
        *,
        keys: Callable[[], Sequence[Mapping[str, Any]]],
        algorithms: Sequence[str],
        now: float,
        bound: float,
        issuer: Optional[str] = None,
    ) -> Tuple[StatusListToken, float]:
        """The list at ``uri``, read within ``bound`` seconds (and its ttl)."""
        with self._lock:
            cached = self._lists.get(uri)
        if cached is not None:
            read: StatusListToken = cached.value
            limit = bound if read.ttl is None else min(bound, read.ttl)
            if now - cached.fetched_at <= limit and read.usable_at(now):
                return read, cached.fetched_at
        try:
            token = _text(self._fetch(uri))
        except Exception as cause:
            # An unreadable list is status_stale, never a pass or an old copy.
            raise Refusal(STATUS_STALE, "status list could not be read: " + uri) from cause
        try:
            read = read_status_list(token, uri=uri, keys=keys(), algorithms=algorithms, now=now, issuer=issuer)
        except JoseError as cause:
            raise Refusal(STATUS_STALE, "status list refused (%s): %s" % (cause.reason, cause)) from cause
        with self._lock:
            self._lists[uri] = _Cached(read, now)
        return read, now

    # ── the registry lookup (60 s) ──────────────────────────────────────────

    def lookup(self, thumbprint: str, now: float, bound: float) -> Tuple[Optional[Mapping[str, Any]], float]:
        limit = min(bound, LOOKUP_MAX_AGE_SECONDS)
        with self._lock:
            cached = self._lookups.get(thumbprint)
        if cached is not None and now - cached.fetched_at <= limit:
            return cached.value, cached.fetched_at
        try:
            answer = self._lookup(thumbprint)
        except Exception as cause:
            # The key's status is unknown: refuse rather than assume it is usable.
            raise Refusal(STATUS_STALE, "the registry lookup failed") from cause
        if answer is not None and not isinstance(answer, Mapping):
            raise Refusal(STATUS_STALE, "the registry lookup answer is unreadable")
        with self._lock:
            self._lookups[thumbprint] = _Cached(answer, now)
        return answer, now


def _reason(refusal: Refusal) -> str:
    cause = refusal.__cause__
    return cause.reason if isinstance(cause, JoseError) else ""
