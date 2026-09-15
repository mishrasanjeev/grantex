"""Evidence packages: build, canonicalise and verify (PRD G-5).

An evidence package is one JSON document per case: the grant chain from root
to leaf with purposes and caps, every tool call with input and output hashes
and the upstream records it returned, run context (model, prompt, policy and
schema versions), policy evaluations with their inputs, recommendations with
citations, human decisions and revocations - all in a hash chain whose root is
recorded in the auth service's audit chain.

- :func:`build_package` assembles and hash-chains a package, pseudonymising
  identifiers unless the case owner discloses them.
- :func:`verify_package` checks package bytes against a trusted root and fails
  closed, naming the first failed check and where it failed.
- :func:`upstream_records_for` lists every upstream record behind a
  recommendation.

The format is specified in ``spec/evidence-package.md``; the TypeScript SDK
implements the same rules and both are tested against
``spec/examples/evidence/``.
"""

from ._build import (
    BuiltPackage,
    PrivacySettings,
    anchor_audit_entry,
    attach_anchor,
    attach_signature,
    build_package,
    serialize_package,
)
from ._canonical import CanonicalizationError, canonicalize
from ._client import EvidenceApiError, ExportedPackage, export_package, record_evidence
from ._document import DEFAULT_MAX_BYTES
from ._hashing import (
    IDENTIFIER_CLASSES,
    PLATFORM_MARKER,
    action_reference,
    case_key,
    is_action_reference,
    keyed_content_digest,
    pseudonym,
    audit_entry_hash,
    chain_root,
    decision_action_hash,
    digest,
    digest_bytes,
    entry_hash,
    header_hash,
    is_pseudonym,
    pseudonymise,
)
from ._result import (
    EvidenceBuildError,
    VerificationCode,
    VerificationFailure,
    VerificationResult,
)
from ._checks import MAX_CLOCK_SKEW_MS
from ._signature import SIGNATURE_TYPE, sign_root, signed_payload, verify_signature
from ._trace import upstream_records_for
from ._verify import FORMAT, SUPPORTED_VERSIONS, verify_package

__all__ = [
    "BuiltPackage",
    "CanonicalizationError",
    "DEFAULT_MAX_BYTES",
    "EvidenceApiError",
    "EvidenceBuildError",
    "ExportedPackage",
    "FORMAT",
    "IDENTIFIER_CLASSES",
    "MAX_CLOCK_SKEW_MS",
    "PLATFORM_MARKER",
    "PrivacySettings",
    "SIGNATURE_TYPE",
    "SUPPORTED_VERSIONS",
    "VerificationCode",
    "VerificationFailure",
    "VerificationResult",
    "action_reference",
    "anchor_audit_entry",
    "attach_anchor",
    "attach_signature",
    "audit_entry_hash",
    "build_package",
    "canonicalize",
    "case_key",
    "chain_root",
    "decision_action_hash",
    "digest",
    "digest_bytes",
    "entry_hash",
    "export_package",
    "header_hash",
    "is_action_reference",
    "is_pseudonym",
    "keyed_content_digest",
    "pseudonym",
    "pseudonymise",
    "record_evidence",
    "serialize_package",
    "sign_root",
    "signed_payload",
    "upstream_records_for",
    "verify_package",
    "verify_signature",
]
