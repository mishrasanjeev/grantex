# SPDX-License-Identifier: Apache-2.0
"""The staleness matrix (PRD section 9) and the informational tier (section 11).

How old a relying party's copy of each authority may be when it relies on it:

    registry keys (the JWK Set the manifest,     24 hours
      acceptance lists and grants verify with)
    the registry manifest (and the issuer keys   1 hour after its iat
      and accreditation it carries)
    status lists (issuer and acceptance) and     the list's ttl, at most 5 minutes;
      the registry lookup                          60 seconds above the HITL
                                                   threshold or for a
                                                   human-not-present Tier A grant
    the revocation feed (when used)              heartbeat 1 s; fail closed
                                                   10 s after the last one

Beyond its bound a source is refetched; one that cannot be refetched is
``status_stale``, never an older copy.

The tier is computed as information only in Phase 1: it chooses the
staleness bound above and is reported, and no policy acts on it. Tier policy
enforcement is Phase 3.
"""

from __future__ import annotations

from typing import Optional

REGISTRY_KEYS_MAX_AGE_SECONDS = 86_400
MANIFEST_MAX_AGE_SECONDS = 3600
#: How often a cached manifest is refetched while it is still inside its hour.
MANIFEST_REFRESH_SECONDS = 300
STATUS_LIST_MAX_STALENESS_SECONDS = 300
STATUS_LIST_HIGH_RISK_STALENESS_SECONDS = 60
#: A public lookup answer may be cached for 60 s (Cache-Control max-age).
LOOKUP_MAX_AGE_SECONDS = 60
FEED_HEARTBEAT_SECONDS = 1
FEED_FAIL_CLOSED_SECONDS = 10

TIERS = ("A", "B", "C")


def compute_tier(
    *, human_present: bool, amount_minor: Optional[int], hitl_threshold_minor: Optional[int]
) -> str:
    """The default tier rules (information only in Phase 1).

    - ``A``: the human is not present (an autonomous purchase);
    - ``C``: the human is present and the amount is above the HITL threshold;
    - ``B``: the human is present at or below the threshold.

    An unknown amount above a configured threshold cannot be ruled out, so it
    reads ``C``.
    """
    if not human_present:
        return "A"
    if hitl_threshold_minor is not None and (amount_minor is None or amount_minor > hitl_threshold_minor):
        return "C"
    return "B"


def status_staleness_bound(
    *,
    amount_minor: Optional[int],
    hitl_threshold_minor: Optional[int],
    human_present: bool,
    tier: str,
) -> int:
    """Seconds a status read may be relied on for this transaction."""
    above_threshold = hitl_threshold_minor is not None and (
        amount_minor is None or amount_minor > hitl_threshold_minor
    )
    if above_threshold or (not human_present and tier == "A"):
        return STATUS_LIST_HIGH_RISK_STALENESS_SECONDS
    return STATUS_LIST_MAX_STALENESS_SECONDS
