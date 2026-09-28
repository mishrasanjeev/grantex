# SPDX-License-Identifier: Apache-2.0
"""verify(): everything a relying party checks before it acts on an agent's request.

The normative description is spec/verification.md, "Relying-party
verification". Each named check is evaluated and reported; the first failing
check in ``CHECK_ORDER`` sets ``denial_code``. A check that cannot be
evaluated because a check it depends on failed is reported as failed with no
code of its own ("not evaluated"), so the denial always names the real cause.

Every authority, status and verification path fails closed: a source that
cannot be read, an answer that cannot be parsed and an unknown state are
refusals, never passes. An exception from the injected nonce store
propagates, as grantex_agent_httpsig documents: the request may be good, so
the caller answers with a server error rather than a denial.
"""

from __future__ import annotations

import hmac
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union
from urllib.parse import urlsplit

from grantex_agent_httpsig import HttpRequest, InnerList, NonceStore, parse_dictionary
from grantex_agent_httpsig import verify as verify_request_signature
from grantex_agent_passport import PassportError, VerifiedPassport, external_credential_hash, verify_passport

from . import _codes as C
from ._codes import CHECK_ORDER, Refusal
from ._grant_status import GrantStatus, GrantStatusSource
from ._jose import JoseError, jwk_set_keys, parse
from ._registry import REGISTRY_ALGORITHMS, Fetcher, RegistryLookup, RegistrySource
from ._staleness import STATUS_LIST_HIGH_RISK_STALENESS_SECONDS, compute_tier, status_staleness_bound
from ._status_list import VALID, INVALID, SUSPENDED, status_name

COMMERCE_TYPE = "urn:grantex:commerce:v1"
BUDGET_TYPE = "urn:grantex:params:oauth:authorization-details:budget"
AGENT_IDENTITY_MARK = "urn:grantex:tm:agent.identity"
GRANT_TOKEN_TYP = "at+jwt"
#: The registry's trust levels, lowest first (apps/auth-service/src/lib/registry/trust-level.ts).
TRUST_LEVELS = ("basic", "verified", "attested", "attested_verified")
CONSTRAINT_MEMBERS = frozenset(
    {"amount_range", "currency", "allowed_merchants", "window", "human_present", "hitl_threshold_minor"}
)
#: Clock difference tolerated on the passport, the grant and the lists (spec/passport-binding.md).
CREDENTIAL_CLOCK_SKEW_SECONDS = 60

TierRules = Callable[..., str]


# ── inputs and results ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class Transaction:
    """What the agent asks the relying party to do.

    ``at`` is when it happens (UNIX seconds; default now), ``amount_minor``
    the amount in minor units, ``currency`` an ISO 4217 code, ``merchant``
    the merchant's origin (default the verifier's own) and ``human_present``
    whether the Principal is present (default: what the grant says, else no).
    Read them from the signed content, never from the query string.
    """

    at: Optional[float] = None
    amount_minor: Optional[int] = None
    currency: Optional[str] = None
    merchant: Optional[str] = None
    human_present: Optional[bool] = None


@dataclass(frozen=True)
class CheckResult:
    ok: bool
    detail: str
    #: When the data this check relied on was read (UNIX seconds), if it was read.
    cached_at: Optional[float] = None
    #: The denial code, when the check failed and was evaluated.
    code: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {"ok": self.ok, "detail": self.detail, "cached_at": self.cached_at, "code": self.code}


@dataclass(frozen=True)
class VerificationResult:
    ok: bool
    denial_code: Optional[str]
    checks: Dict[str, CheckResult]
    #: The registry's computed trust level and flags, from the lookup.
    level: Optional[str]
    flags: Tuple[str, ...]
    #: Informational in Phase 1 (A, B or C); no policy acts on it until Phase 3.
    tier: Optional[str]
    #: What was relied on, for the relying party's records (PRD section 8.10).
    evidence: Dict[str, Any]
    passport: Optional[VerifiedPassport] = None
    grant_claims: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "denial_code": self.denial_code,
            "checks": {name: check.to_dict() for name, check in self.checks.items()},
            "level": self.level,
            "flags": list(self.flags),
            "tier": self.tier,
            "evidence": self.evidence,
        }


def _authority_of(origin: str) -> Tuple[str, str]:
    """(normalised origin, @authority) for an origin (RFC 9421 section 2.2.3)."""
    parts = urlsplit(origin)
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise ValueError("origin must be an http(s) origin such as https://merchant.example")
    if parts.path not in ("", "/") or parts.query or parts.fragment or parts.username or parts.password:
        raise ValueError("origin must have no path, query, fragment or credentials")
    host = parts.hostname.lower()
    if ":" in host:
        host = "[" + host + "]"
    port = parts.port
    default = 443 if parts.scheme == "https" else 80
    authority = host if port is None or port == default else "%s:%d" % (host, port)
    return parts.scheme + "://" + authority, authority


class VerifierConfig:
    """A relying party's trust configuration, and the caches the staleness matrix governs.

    Create one per process and reuse it. ``fetch(url)`` returns a document
    (str or bytes) or raises; it must only follow the transport rules the
    relying party accepts (https, no redirects). ``registry_lookup(thumbprint)``
    returns the registry lookup answer for a key thumbprint
    (``GET /v1/registry/agents?key_thumbprint=``) or None when the registry
    knows no such key, and may raise. ``registry_jwks`` is the registry's JWK
    Set or its URL; keys are only ever taken from it and from the manifest it
    verifies.
    """

    def __init__(
        self,
        *,
        origin: str,
        registry_issuer: str,
        registry_jwks: Union[str, Mapping[str, Any]],
        manifest_url: str,
        fetch: Fetcher,
        registry_lookup: RegistryLookup,
        grant_status: GrantStatusSource,
        nonce_store: NonceStore,
        audience: Optional[str] = None,
        hitl_threshold_minor: Optional[int] = None,
        min_level: Optional[str] = None,
        clock: Callable[[], float] = time.time,
        clock_skew_seconds: int = 10,
        payments_rails: bool = True,
        allow_eddsa: bool = False,
        tier_rules: TierRules = compute_tier,
    ) -> None:
        self.origin, self.authority = _authority_of(origin)
        if not isinstance(registry_issuer, str) or registry_issuer == "":
            raise ValueError("registry_issuer is required")
        if min_level is not None and min_level not in TRUST_LEVELS:
            raise ValueError("min_level must be one of " + ", ".join(TRUST_LEVELS))
        if hitl_threshold_minor is not None and (
            isinstance(hitl_threshold_minor, bool) or not isinstance(hitl_threshold_minor, int)
        ):
            raise ValueError("hitl_threshold_minor must be an integer")
        self.audience = audience if audience is not None else self.origin
        self.registry_issuer = registry_issuer
        self.grant_status = grant_status
        self.nonce_store = nonce_store
        self.hitl_threshold_minor = hitl_threshold_minor
        self.min_level = min_level
        self.clock = clock
        self.clock_skew_seconds = clock_skew_seconds
        self.payments_rails = payments_rails
        self.allow_eddsa = allow_eddsa
        self.tier_rules = tier_rules
        self.source = RegistrySource(
            registry_issuer=registry_issuer,
            registry_jwks=registry_jwks,
            manifest_url=manifest_url,
            fetch=fetch,
            lookup=registry_lookup,
        )


# ── helpers ──────────────────────────────────────────────────────────────────


class _NotEvaluated(Exception):
    """A check that depends on one that failed."""


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _passport_issuer_and_kid(passport: str) -> Tuple[Optional[str], Optional[str]]:
    """``iss`` and ``kid`` read before the signature, as the registry does, so an
    unknown issuer is refused as such. Nothing here is trusted."""
    try:
        jws = parse(passport.split("~", 1)[0])
    except JoseError:
        # Not a JWS: passport.signature refuses it; accreditation is not evaluated.
        return None, None
    iss, kid = jws.payload.get("iss"), jws.header.get("kid")
    return (iss if isinstance(iss, str) else None), (kid if isinstance(kid, str) else None)


def _request_keyid(request: HttpRequest) -> Optional[str]:
    """The ``keyid`` of the request's agent-payer-auth signature, unverified."""
    value = None
    headers = request.headers
    pairs = headers.items() if isinstance(headers, Mapping) else headers
    for name, v in pairs:
        if name.lower() == "signature-input":
            value = v if isinstance(v, str) else ", ".join(v)
    if value is None:
        return None
    try:
        members = parse_dictionary(value)
    except ValueError:
        # An unparseable Signature-Input names no key; request.signature refuses it.
        return None
    for member in members.values():
        if isinstance(member, InnerList) and member.params.get("tag") == "agent-payer-auth":
            keyid = member.params.get("keyid")
            return keyid if isinstance(keyid, str) else None
    return None


# Characters a WHATWG URL parser would percent-encode or rewrite in an https
# path (the path percent-encode set, plus a backslash, which it reads as "/").
_NON_CANONICAL_PATH_CHARACTER = re.compile(r'[\x00-\x20\x7f-\U0010ffff"<>`{}\\]')


def _is_dot_segment(segment: str) -> bool:
    # WHATWG URL "single-dot" and "double-dot" path segments, including their
    # percent-encoded spellings ("%2e", any case).
    return segment.lower().replace("%2e", ".") in (".", "..")


def _under_base(uri: str, base: str) -> bool:
    """owner decision 8, as statusUriUnderBase in the registry: an https URI
    under the issuer's status_list_base, with no query or fragment, that is
    already in the form a URL parser serialises it to (the registry requires
    new URL(uri).href === uri). A dot segment or a character the parser would
    rewrite would let the fetched path leave the base, so either refuses."""
    parts = urlsplit(uri)
    if parts.scheme != "https" or not uri.startswith("https://") or parts.query or parts.fragment:
        return False
    if "?" in uri or "#" in uri or _NON_CANONICAL_PATH_CHARACTER.search(uri):
        return False
    if any(_is_dot_segment(segment) for segment in parts.path.split("/")):
        return False
    return base.endswith("/") and uri.startswith(base) and len(uri) > len(base)


@dataclass
class _Constraints:
    amount_min: Optional[int] = None
    amount_max: Optional[int] = None
    currency: Optional[str] = None
    merchants: Optional[List[str]] = None
    not_before: Optional[int] = None
    not_after: Optional[int] = None
    human_present: Optional[bool] = None
    hitl_threshold_minor: Optional[int] = None


def _parse_constraints(raw: Any) -> _Constraints:
    """The commerce entry's ``constraints``; anything unreadable raises Refusal."""

    def bad(message: str) -> Refusal:
        return Refusal(C.TOKEN_INVALID, "constraints: " + message)

    if not isinstance(raw, Mapping):
        raise bad("not an object")
    unknown = set(raw) - CONSTRAINT_MEMBERS
    if unknown:
        # A member this verifier does not understand may restrict the grant:
        # refuse rather than ignore a restriction.
        raise bad("unknown members " + ", ".join(sorted(unknown)))
    out = _Constraints()
    if "amount_range" in raw:
        r = raw["amount_range"]
        if not isinstance(r, Mapping) or set(r) - {"min_minor", "max_minor"}:
            raise bad("amount_range must be {min_minor, max_minor}")
        for name in ("min_minor", "max_minor"):
            if name in r and not (_is_int(r[name]) and r[name] >= 0):
                raise bad("amount_range.%s must be a non-negative integer" % name)
        out.amount_min, out.amount_max = r.get("min_minor"), r.get("max_minor")
    if "currency" in raw:
        if not isinstance(raw["currency"], str) or not re.fullmatch(r"[A-Z]{3}", raw["currency"]):
            raise bad("currency must be an ISO 4217 code")
        out.currency = raw["currency"]
    if "allowed_merchants" in raw:
        merchants = raw["allowed_merchants"]
        if not isinstance(merchants, list) or not all(isinstance(m, str) for m in merchants):
            raise bad("allowed_merchants must be a list of origins")
        out.merchants = list(merchants)
    if "window" in raw:
        w = raw["window"]
        if not isinstance(w, Mapping) or set(w) - {"not_before", "not_after"}:
            raise bad("window must be {not_before, not_after}")
        for name in ("not_before", "not_after"):
            if name in w and not _is_int(w[name]):
                raise bad("window.%s must be an integer" % name)
        out.not_before, out.not_after = w.get("not_before"), w.get("not_after")
    if "human_present" in raw:
        if not isinstance(raw["human_present"], bool):
            raise bad("human_present must be a boolean")
        out.human_present = raw["human_present"]
    if "hitl_threshold_minor" in raw:
        if not (_is_int(raw["hitl_threshold_minor"]) and raw["hitl_threshold_minor"] >= 0):
            raise bad("hitl_threshold_minor must be a non-negative integer")
        out.hitl_threshold_minor = raw["hitl_threshold_minor"]
    return out


def _entries(claims: Mapping[str, Any], kind: str) -> List[Mapping[str, Any]]:
    details = claims.get("authorization_details")
    if not isinstance(details, list):
        return []
    return [d for d in details if isinstance(d, Mapping) and d.get("type") == kind]


# ── verify ───────────────────────────────────────────────────────────────────


class _Run:
    def __init__(self, passport: str, grant: str, request: HttpRequest, tx: Transaction, config: VerifierConfig):
        self.passport_token = passport
        self.grant_token = grant
        self.request = request
        self.tx = tx
        self.config = config
        self.source = config.source
        self.now = float(config.clock())
        self.at = float(tx.at) if tx.at is not None else self.now
        self.checks: Dict[str, CheckResult] = {}
        self.passport: Optional[VerifiedPassport] = None
        self.grant: Optional[Dict[str, Any]] = None
        self.commerce: Optional[Mapping[str, Any]] = None
        self.constraints: Optional[_Constraints] = None
        self.constraints_error: Optional[Refusal] = None
        self.manifest: Optional[Dict[str, Any]] = None
        self.manifest_at: Optional[float] = None
        self.manifest_error: Optional[Refusal] = None
        self.issuer_entry: Optional[Mapping[str, Any]] = None
        self.lookup: Optional[Mapping[str, Any]] = None
        self.lookup_error: Optional[Refusal] = None
        self.bound: float = STATUS_LIST_HIGH_RISK_STALENESS_SECONDS
        self.tier: Optional[str] = None
        self.evidence: Dict[str, Any] = {}

    def check(self, name: str, fn: Callable[[], Tuple[str, Optional[float]]]) -> None:
        try:
            detail, cached_at = fn()
        except Refusal as refusal:
            self.checks[name] = CheckResult(False, refusal.detail, None, refusal.code)
            return
        except _NotEvaluated as reason:
            self.checks[name] = CheckResult(False, "not evaluated: " + str(reason))
            return
        self.checks[name] = CheckResult(True, detail, cached_at)

    def needs(self, *names: str) -> None:
        for name in names:
            if not self.checks[name].ok:
                raise _NotEvaluated(name + " failed")

    # ── grant.signature (evaluated first: the tier depends on the grant) ────

    def grant_signature(self) -> Tuple[str, Optional[float]]:
        try:
            claims, keys_at = self.source.verify_registry_jws(self.grant_token, GRANT_TOKEN_TYP, self.now)
        except JoseError as error:
            raise Refusal(C.TOKEN_INVALID, "grant: %s (%s)" % (error, error.reason)) from error
        skew = CREDENTIAL_CLOCK_SKEW_SECONDS
        if claims.get("iss") != self.config.registry_issuer:
            raise Refusal(C.TOKEN_INVALID, "grant: iss is not the configured registry")
        exp: Any = claims.get("exp")
        iat: Any = claims.get("iat")
        nbf: Any = claims.get("nbf")
        if not _is_int(exp) or not _is_int(iat) or ("nbf" in claims and not _is_int(nbf)):
            raise Refusal(C.TOKEN_INVALID, "grant: exp and iat must be integers")
        if self.now >= exp + skew:
            raise Refusal(C.TOKEN_INVALID, "grant: expired")
        if iat > self.now + skew or (_is_int(nbf) and nbf > self.now + skew):
            raise Refusal(C.TOKEN_INVALID, "grant: not valid yet")
        if not isinstance(claims.get("jti"), str) or not isinstance(claims.get("sub"), str):
            raise Refusal(C.TOKEN_INVALID, "grant: jti and sub are required")
        details = claims.get("authorization_details")
        if "authorization_details" in claims and not isinstance(details, list):
            raise Refusal(C.TOKEN_INVALID, "grant: authorization_details must be an array")
        commerce = _entries(claims, COMMERCE_TYPE)
        if len(commerce) > 1:
            raise Refusal(C.TOKEN_INVALID, "grant: more than one %s entry" % COMMERCE_TYPE)
        self.grant = claims
        self.commerce = commerce[0] if commerce else None
        return "grant verified with the registry's keys", keys_at

    def derive_tier(self) -> None:
        """The tier and the status staleness bound (PRD sections 9 and 11)."""
        if self.grant is None:
            # Without a verified grant nothing lowers the risk: use the tighter bound.
            self.bound = STATUS_LIST_HIGH_RISK_STALENESS_SECONDS
            return
        if self.commerce is not None and "constraints" in self.commerce:
            try:
                self.constraints = _parse_constraints(self.commerce["constraints"])
            except Refusal as refusal:
                # Reported by the constraints check; the tier uses the defaults.
                self.constraints_error = refusal
        c = self.constraints or _Constraints()
        human_present = self.tx.human_present
        if human_present is None:
            human_present = bool(c.human_present)
        thresholds = [t for t in (self.config.hitl_threshold_minor, c.hitl_threshold_minor) if t is not None]
        threshold = min(thresholds) if thresholds else None
        self.tier = self.config.tier_rules(
            human_present=human_present, amount_minor=self.tx.amount_minor, hitl_threshold_minor=threshold
        )
        self.bound = status_staleness_bound(
            amount_minor=self.tx.amount_minor,
            hitl_threshold_minor=threshold,
            human_present=human_present,
            tier=self.tier,
        )

    def load_manifest(self) -> None:
        try:
            self.manifest, self.manifest_at = self.source.manifest(self.now)
        except Refusal as refusal:
            # Kept and reported by every check that depends on the manifest.
            self.manifest_error = refusal

    def require_manifest(self) -> Dict[str, Any]:
        if self.manifest is None:
            assert self.manifest_error is not None
            raise Refusal(self.manifest_error.code, self.manifest_error.detail)
        return self.manifest

    # ── issuer.accredited ───────────────────────────────────────────────────

    def issuer_accredited(self) -> Tuple[str, Optional[float]]:
        iss, _ = _passport_issuer_and_kid(self.passport_token)
        if iss is None:
            raise _NotEvaluated("the passport names no issuer")
        manifest = self.require_manifest()
        entry = next((i for i in manifest["issuers"] if i["entity_id"] == iss), None)
        if entry is None:
            raise Refusal(C.ISSUER_NOT_ACCREDITED, "%s is not in the registry manifest" % iss)
        self.issuer_entry = entry
        status = entry["status"]
        # The status in effect when the manifest was issued (at most an hour
        # ago); the manifest does not carry the future suspension times.
        if status == "suspended":
            raise Refusal(C.ISSUER_SUSPENDED, "%s is suspended" % iss)
        if status != "active":
            raise Refusal(C.ISSUER_NOT_ACCREDITED, "%s is %s" % (iss, status))
        if AGENT_IDENTITY_MARK not in entry["trust_marks"]:
            raise Refusal(C.TRUST_MARK_MISSING, "%s is not accredited for %s" % (iss, AGENT_IDENTITY_MARK))
        return "accredited for %s (manifest iat %d)" % (AGENT_IDENTITY_MARK, manifest["iat"]), self.manifest_at

    # ── passport.signature ──────────────────────────────────────────────────

    def issuer_keys(self, iss: str) -> List[Mapping[str, Any]]:
        manifest = self.manifest or {}
        for entry in manifest.get("issuers", []):
            if entry["entity_id"] == iss:
                return list(jwk_set_keys(entry["jwks"]) or [])
        return []

    def passport_signature(self) -> Tuple[str, Optional[float]]:
        self.require_manifest()
        _, kid = _passport_issuer_and_kid(self.passport_token)
        if kid is None:
            # Owner decision 7: an issuer key is named by kid; a passport without one has no key.
            raise Refusal(C.PASSPORT_INVALID_SIGNATURE, "the passport header names no kid")

        def resolver(iss: str) -> List[Mapping[str, Any]]:
            # Keys only from the signed manifest, never from the token (PRD section 13).
            return [k for k in self.issuer_keys(iss) if k.get("kid") == kid]

        try:
            self.passport = verify_passport(
                self.passport_token,
                issuer_keys=resolver,
                now=self.now,
                payments_rails=self.config.payments_rails,
                allow_eddsa=self.config.allow_eddsa,
                clock_skew_seconds=CREDENTIAL_CLOCK_SKEW_SECONDS,
                # The passport.status check below reads the issuer's list itself,
                # under the manifest's status_list_base; it always runs.
                status_checked_by="caller",
            )
        except PassportError as error:
            raise Refusal(error.code, "passport: %s (%s)" % (error, error.reason)) from error
        return "signed by %s key %s from the manifest" % (self.passport.iss, kid), self.manifest_at

    # ── passport.status ─────────────────────────────────────────────────────

    def passport_status(self) -> Tuple[str, Optional[float]]:
        self.needs("passport.signature")
        passport = self.passport
        assert passport is not None
        ref = passport.status["status_list"]
        uri, idx = ref["uri"], int(ref["idx"])
        record: Dict[str, Any] = {"uri": uri, "idx": idx, "status": None, "ok": False, "cached_at": None}
        self.evidence["passport_status"] = record
        base = next(
            (i["status_list_base"] for i in (self.manifest or {}).get("issuers", []) if i["entity_id"] == passport.iss),
            None,
        )
        if base is None or not _under_base(uri, base):
            raise Refusal(C.STATUS_STALE, "the status list is not under the issuer's status_list_base")
        algorithms = ("ES256", "EdDSA") if self.config.allow_eddsa else ("ES256",)
        read, fetched_at = self.source.status_list(
            uri, keys=lambda: self.issuer_keys(passport.iss), algorithms=algorithms, now=self.now, bound=self.bound
        )
        try:
            value = read.entry(idx)
        except JoseError as error:
            raise Refusal(C.STATUS_STALE, str(error)) from error
        record.update(status=status_name(value), cached_at=fetched_at)
        if value != VALID:
            raise Refusal(C.PASSPORT_REVOKED, "the issuer's status is %s" % status_name(value))
        record["ok"] = True
        return "VALID in the issuer's status list", fetched_at

    # ── attestation.registered ──────────────────────────────────────────────

    def binding(self) -> Mapping[str, Any]:
        if self.commerce is None:
            raise Refusal(C.ATTESTATION_NOT_REGISTERED, "the grant is not bound to an Agent Passport")
        binding = self.commerce.get("passport")
        if not isinstance(binding, Mapping) or not all(
            isinstance(binding.get(k), str) for k in ("issuer", "id", "hash", "key_thumbprint")
        ):
            raise Refusal(C.TOKEN_INVALID, "the grant's passport binding is malformed")
        return binding

    def attestation_registered(self) -> Tuple[str, Optional[float]]:
        self.needs("passport.signature", "grant.signature")
        passport = self.passport
        assert passport is not None
        binding = self.binding()
        attestation_id = passport.disclosed.get("attestation_id")
        if not isinstance(attestation_id, str):
            raise Refusal(C.ATTESTATION_NOT_REGISTERED, "the passport does not disclose attestation_id")
        if not _same(binding["issuer"], passport.iss):
            raise Refusal(C.ATTESTATION_MISMATCH, "the grant is bound to a passport of another issuer")
        if not _same(binding["id"], attestation_id):
            raise Refusal(C.ATTESTATION_NOT_REGISTERED, "the grant is bound to another attestation")
        if not _same(binding["hash"], passport.external_credential_hash):
            raise Refusal(C.ATTESTATION_HASH_MISMATCH, "the grant is bound to another passport hash")
        return "the grant is bound to attestation %s and this passport's hash" % attestation_id, None

    # ── attestation.accepted ────────────────────────────────────────────────

    def attestation_accepted(self) -> Tuple[str, Optional[float]]:
        self.needs("grant.signature")
        if self.commerce is None:
            raise Refusal(C.ATTESTATION_NOT_REGISTERED, "the grant carries no acceptance entry")
        ref = self.commerce.get("acceptance_status")
        if not isinstance(ref, Mapping) or not isinstance(ref.get("uri"), str) or not (
            _is_int(ref.get("idx")) and ref["idx"] >= 0
        ):
            raise Refusal(C.ATTESTATION_NOT_REGISTERED, "the grant's acceptance entry is malformed")
        uri, idx = ref["uri"], ref["idx"]
        record: Dict[str, Any] = {"uri": uri, "idx": idx, "status": None, "ok": False, "cached_at": None}
        self.evidence["acceptance_status"] = record
        manifest = self.require_manifest()
        template = manifest["endpoints"].get("acceptance_status_list")
        prefix = template.split("{list}", 1)[0] if isinstance(template, str) and "{list}" in template else None
        if prefix is None or not _under_base(uri, prefix) or "/" in uri[len(prefix):]:
            raise Refusal(C.ATTESTATION_NOT_REGISTERED, "the acceptance list is not one of the registry's")
        read, fetched_at = self.source.status_list(
            uri,
            keys=lambda: self.source.registry_keys(self.now)[0],
            algorithms=REGISTRY_ALGORITHMS,
            now=self.now,
            bound=self.bound,
            issuer=self.config.registry_issuer,
        )
        try:
            value = read.entry(idx)
        except JoseError as error:
            raise Refusal(C.STATUS_STALE, str(error)) from error
        record.update(status=status_name(value), cached_at=fetched_at)
        if value == INVALID:
            raise Refusal(C.ATTESTATION_NOT_ACCEPTED, "acceptance_invalid: the registry withdrew its acceptance")
        if value == SUSPENDED:
            raise Refusal(C.ATTESTATION_NOT_ACCEPTED, "acceptance_suspended: the registry suspended its acceptance")
        if value != VALID:
            raise Refusal(C.ATTESTATION_NOT_ACCEPTED, "the registry's acceptance is %s" % status_name(value))
        record["ok"] = True
        return "VALID in the registry's acceptance list", fetched_at

    # ── grant.status and grant.audience ─────────────────────────────────────

    def record(self) -> Mapping[str, Any]:
        assert self.grant is not None
        record = self.grant.get("urn:grantex:grant")
        return record if isinstance(record, Mapping) else {}

    def grant_status(self) -> Tuple[str, Optional[float]]:
        self.needs("grant.signature")
        assert self.grant is not None
        record = self.record()
        grant_id = str(record["grant_id"]) if isinstance(record.get("grant_id"), str) else str(self.grant["jti"])
        parent = record.get("parent_grant_id")
        try:
            status = self.config.grant_status.grant_status(
                grant_id=grant_id,
                token_id=str(self.grant["jti"]),
                parent_grant_id=parent if isinstance(parent, str) else None,
            )
        except Exception as cause:
            # The revocation state is unknown: refuse (fail closed), keep the cause.
            raise Refusal(C.STATUS_STALE, "the grant's revocation status could not be read") from cause
        if not isinstance(status, GrantStatus):
            raise Refusal(C.STATUS_STALE, "the grant status source returned something unreadable")
        if status.state in ("revoked", "suspended"):
            raise Refusal(C.GRANT_REVOKED, "the grant is %s" % status.state)
        if status.state != "active":
            raise Refusal(C.STATUS_STALE, "the grant's revocation status is unknown: " + status.detail)
        return "the grant is not revoked", status.checked_at

    def is_child(self) -> bool:
        return isinstance(self.record().get("parent_grant_id"), str)

    def grant_audience(self) -> Tuple[str, Optional[float]]:
        self.needs("grant.signature")
        assert self.grant is not None
        aud = self.grant.get("aud")
        values = [aud] if isinstance(aud, str) else aud if isinstance(aud, list) else []
        # A child grant is for one merchant: its aud is the merchant's origin.
        expected = self.config.origin if self.is_child() else self.config.audience
        if not any(isinstance(v, str) and v == expected for v in values):
            raise Refusal(C.AUDIENCE_MISMATCH, "the grant's aud is not %s" % expected)
        return "aud is %s" % expected, None

    # ── key.binding and key.status ──────────────────────────────────────────

    def key_binding(self) -> Tuple[str, Optional[float]]:
        self.needs("passport.signature", "grant.signature")
        passport, grant = self.passport, self.grant
        assert passport is not None and grant is not None
        thumbprint = passport.cnf_thumbprint
        cnf = grant.get("cnf")
        jkt = cnf.get("jkt") if isinstance(cnf, Mapping) else None
        # Key equality (agent-passport-1.0.md section 7): RFC 7638 thumbprints are equal.
        if not isinstance(jkt, str) or not _same(jkt, thumbprint):
            raise Refusal(C.KEY_BINDING_MISMATCH, "the grant's cnf.jkt is not the passport's key")
        if self.commerce is not None:
            bound = self.commerce.get("passport")
            if isinstance(bound, Mapping) and not (
                isinstance(bound.get("key_thumbprint"), str) and _same(bound["key_thumbprint"], thumbprint)
            ):
                raise Refusal(C.KEY_BINDING_MISMATCH, "the grant's passport binding names another key")
        keyid = _request_keyid(self.request)
        if keyid is None or not _same(keyid, thumbprint):
            raise Refusal(C.KEY_BINDING_MISMATCH, "the request is not signed with the passport's key")
        return "passport cnf, grant cnf.jkt and request keyid are %s" % thumbprint, None

    def key_status(self) -> Tuple[str, Optional[float]]:
        self.needs("passport.signature")
        passport = self.passport
        assert passport is not None
        try:
            answer, fetched_at = self.source.lookup(passport.cnf_thumbprint, self.now, self.bound)
        except Refusal as refusal:
            self.lookup_error = refusal
            raise
        if answer is None:
            raise Refusal(C.KEY_UNPROVEN, "no agent in the registry holds this key")
        self.lookup = answer
        if answer.get("agent_did") != passport.sub:
            raise Refusal(C.KEY_BINDING_MISMATCH, "the registry holds this key for another agent")
        if "key_thumbprint" in answer and answer["key_thumbprint"] != passport.cnf_thumbprint:
            raise Refusal(C.KEY_BINDING_MISMATCH, "the lookup answered for another key")
        status, current = answer.get("key_status"), answer.get("key_current")
        if status == "compromised":
            raise Refusal(C.KEY_NOT_ACTIVE, "the key is reported compromised")
        if status == "pending":
            raise Refusal(C.KEY_UNPROVEN, "possession of the key has not been proven")
        if status not in ("active", "rotated") or current is not True:
            # Rotated past its overlap, or a state this verifier does not know: fail closed.
            raise Refusal(C.KEY_NOT_ACTIVE, "the key is %s and not current" % status)
        return "the key is %s and current" % status, fetched_at

    # ── request.signature ───────────────────────────────────────────────────

    def request_signature(self) -> Tuple[str, Optional[float]]:
        passport = self.passport

        def resolve_key(keyid: str) -> Optional[Mapping[str, Any]]:
            # Only the key the verified passport is bound to.
            if passport is not None and _same(keyid, passport.cnf_thumbprint):
                return passport.cnf_jwk
            return None

        result = verify_request_signature(
            self.request,
            resolve_key=resolve_key,
            expected_authority=self.config.authority,
            nonce_store=self.config.nonce_store,
            now=int(self.now),
            clock_skew_seconds=self.config.clock_skew_seconds,
        )
        if not result.ok:
            assert result.code is not None
            raise Refusal(result.code, "request: %s" % result.reason)
        if result.agent_passport != self.passport_token or result.agent_grant != self.grant_token:
            raise Refusal(
                C.REQUEST_SIGNATURE_INVALID,
                "request: presentation_not_signed (the credentials are not the ones the request signed)",
            )
        return "signed with the passport's key for %s (%s)" % (self.config.authority, result.alg), None

    # ── level, constraints, budget ──────────────────────────────────────────

    def level(self) -> Tuple[str, Optional[float]]:
        if self.lookup is None:
            if self.lookup_error is not None:
                raise Refusal(self.lookup_error.code, self.lookup_error.detail)
            raise _NotEvaluated("key.status failed")
        level = self.lookup.get("level")
        if self.config.min_level is None:
            return "level %s; no minimum configured" % level, None
        if level not in TRUST_LEVELS or TRUST_LEVELS.index(level) < TRUST_LEVELS.index(self.config.min_level):
            raise Refusal(C.LEVEL_BELOW_POLICY, "level %s is below %s" % (level, self.config.min_level))
        return "level %s meets %s" % (level, self.config.min_level), None

    def constraints_check(self) -> Tuple[str, Optional[float]]:
        self.needs("grant.signature")
        if self.constraints_error is not None:
            raise self.constraints_error
        c = self.constraints
        if c is None:
            return "the grant carries no commerce constraints", None
        tx = self.tx
        if c.not_before is not None and self.at < c.not_before:
            raise Refusal(C.CAP_EXCEEDED, "outside_window: before the grant's window")
        if c.not_after is not None and self.at >= c.not_after:
            raise Refusal(C.CAP_EXCEEDED, "outside_window: after the grant's window")
        merchant = tx.merchant if tx.merchant is not None else self.config.origin
        if c.merchants is not None and merchant not in c.merchants:
            raise Refusal(C.AUDIENCE_MISMATCH, "merchant_not_allowed: %s" % merchant)
        if c.currency is not None and tx.currency != c.currency:
            raise Refusal(C.CAP_EXCEEDED, "currency_not_allowed: %s" % tx.currency)
        if c.amount_min is not None or c.amount_max is not None:
            amount = tx.amount_minor
            if not _is_int(amount):
                raise Refusal(C.CAP_EXCEEDED, "amount_unknown: the grant limits the amount")
            assert isinstance(amount, int)
            if (c.amount_min is not None and amount < c.amount_min) or (
                c.amount_max is not None and amount > c.amount_max
            ):
                raise Refusal(C.CAP_EXCEEDED, "amount_out_of_range: %d" % amount)
        return "within the grant's constraints", None

    def budget(self) -> Tuple[str, Optional[float]]:
        self.needs("grant.signature")
        assert self.grant is not None
        entries = _entries(self.grant, BUDGET_TYPE)
        if not entries:
            return "the grant carries no budget", None
        entry = entries[0]
        amount, currency = entry.get("amount"), entry.get("currency")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not isinstance(currency, str):
            raise Refusal(C.TOKEN_INVALID, "the grant's budget entry is unreadable")
        self.evidence["budget"] = {"amount": amount, "currency": currency}
        # Reported, not enforced: the authorization server debits the budget.
        return "remaining at issuance: %s %s (enforced by the authorization server)" % (amount, currency), None


def verify(
    passport: str,
    grant: str,
    request: HttpRequest,
    tx: Transaction,
    *,
    config: VerifierConfig,
) -> VerificationResult:
    """Verify an agent's request: its Agent Passport, its grant, the request
    signature, both status sources and the transaction's fit with the grant.

    ``passport`` and ``grant`` are the presentations the request carries
    (``presentations_from_request``). Every check in ``CHECK_ORDER`` is
    reported; ``ok`` only when all pass.
    """
    run = _Run(passport, grant, request, tx, config)
    run.check("grant.signature", run.grant_signature)
    run.derive_tier()
    run.load_manifest()
    run.check("issuer.accredited", run.issuer_accredited)
    run.check("passport.signature", run.passport_signature)
    run.check("passport.status", run.passport_status)
    run.check("attestation.registered", run.attestation_registered)
    run.check("attestation.accepted", run.attestation_accepted)
    run.check("grant.status", run.grant_status)
    run.check("grant.audience", run.grant_audience)
    run.check("key.binding", run.key_binding)
    run.check("key.status", run.key_status)
    run.check("request.signature", run.request_signature)
    run.check("level", run.level)
    run.check("constraints", run.constraints_check)
    run.check("budget.remaining", run.budget)

    checks = {name: run.checks[name] for name in CHECK_ORDER}
    denial = next((c.code for c in checks.values() if not c.ok and c.code is not None), None)
    ok = all(c.ok for c in checks.values())
    if not ok and denial is None:
        # Unreachable by construction (a not-evaluated check always follows a
        # failed one with a code); refuse rather than answer ok without one.
        denial = C.REQUEST_SIGNATURE_INVALID
    level = run.lookup.get("level") if run.lookup is not None else None
    level = level if isinstance(level, str) else None
    raw_flags = run.lookup.get("flags") if run.lookup is not None else None
    flags = tuple(f for f in raw_flags if isinstance(f, str)) if isinstance(raw_flags, list) else ()
    evidence = _evidence(run, level, flags, denial)
    return VerificationResult(
        ok=ok,
        denial_code=None if ok else denial,
        checks=checks,
        level=level,
        flags=flags,
        tier=run.tier,
        evidence=evidence,
        passport=run.passport,
        grant_claims=run.grant,
    )


def _evidence(run: _Run, level: Optional[str], flags: Sequence[str], denial: Optional[str]) -> Dict[str, Any]:
    """PRD section 8.10: what the decision rested on, at verification time."""
    passport = run.passport
    try:
        passport_hash: Optional[str] = (
            passport.external_credential_hash if passport else external_credential_hash(run.passport_token)
        )
    except PassportError:
        # A presentation that is not an SD-JWT has no hash to record.
        passport_hash = None
    grant_id = None
    if run.grant is not None:
        grant_id = run.record().get("grant_id") or run.grant.get("jti")
    return {
        "verified_at": run.now,
        "transaction_at": run.at,
        "agent_did": passport.sub if passport else None,
        "issuer": passport.iss if passport else None,
        "passport_hash": passport_hash,
        "attestation_id": passport.disclosed.get("attestation_id") if passport else None,
        "key_thumbprint": passport.cnf_thumbprint if passport else None,
        "grant_id": grant_id,
        "passport_status": run.evidence.get("passport_status"),
        "acceptance_status": run.evidence.get("acceptance_status"),
        "level": level,
        "flags": list(flags),
        "tier": run.tier,
        "budget": run.evidence.get("budget"),
        "denial_code": denial if not all(c.ok for c in run.checks.values()) else None,
        "manifest_iat": run.manifest["iat"] if run.manifest else None,
    }
