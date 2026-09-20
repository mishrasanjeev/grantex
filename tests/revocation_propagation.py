"""Python parity for the G-6 release test.

Revokes a parent grant and measures how long the child grant keeps being
allowed by ``enforce(revocation_check="feed")``. Runs against a real auth
service with Postgres and Redis behind it (scripts/revocation-release-test.sh),
never against production: the base URL must be given explicitly.

    REVOCATION_RELEASE_BASE_URL=http://127.0.0.1:3199 python tests/revocation_propagation.py
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from typing import Any

import httpx

from grantex import DenialReason, Grantex, Permission, RevocationSubReason, ToolManifest
from grantex._types import AuthorizeParams, ExchangeTokenParams, SignupParams

BASE_URL = os.environ.get("REVOCATION_RELEASE_BASE_URL")
TRIALS = int(os.environ.get("REVOCATION_RELEASE_TRIALS", "10"))
BUDGET_MS = float(os.environ.get("REVOCATION_RELEASE_BUDGET_MS", "2000"))
REPORT = os.environ.get("REVOCATION_RELEASE_REPORT_PY")
SCOPES = ["tool:acme_kyb:read"]


def _percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.ceil(fraction * len(ordered)) - 1)
    return ordered[max(0, index)]


def _approve(api_key: str, auth_request_id: str) -> str:
    response = httpx.post(
        f"{BASE_URL}/v1/authorize/{auth_request_id}/approve",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={},
        timeout=30.0,
    )
    response.raise_for_status()
    return str(response.json()["code"])


def main() -> int:
    if not BASE_URL:
        print("REVOCATION_RELEASE_BASE_URL is not set; skipping", file=sys.stderr)
        return 0

    account = Grantex.signup(
        SignupParams(name=f"revocation-release-py-{int(time.time())}", mode="sandbox"),
        base_url=BASE_URL,
    )
    admin = Grantex(api_key=account.api_key, base_url=BASE_URL)
    stamp = int(time.time())
    root = admin.agents.register(name=f"release-py-root-{stamp}", scopes=SCOPES)
    middle = admin.agents.register(name=f"release-py-middle-{stamp}", scopes=SCOPES)
    leaf = admin.agents.register(name=f"release-py-leaf-{stamp}", scopes=SCOPES)

    auth = admin.authorize(
        AuthorizeParams(agent_id=root.id, user_id=f"release-py-user-{stamp}", scopes=SCOPES)
    )
    code = auth.code or _approve(account.api_key, auth.request_id)
    root_grant = admin.tokens.exchange(ExchangeTokenParams(code=code, agent_id=root.id))

    pairs: list[tuple[str, str]] = []
    for _ in range(TRIALS):
        parent = admin.grants.delegate(
            parent_grant_token=root_grant.grant_token, sub_agent_id=middle.id, scopes=SCOPES, expires_in="1h"
        )
        child = admin.grants.delegate(
            parent_grant_token=parent["grantToken"], sub_agent_id=leaf.id, scopes=SCOPES, expires_in="1h"
        )
        pairs.append((parent["grantId"], child["grantToken"]))

    enforcer = Grantex(
        api_key=account.api_key,
        base_url=BASE_URL,
        revocation_check="feed",
        revocation_feed_stale_after=5.0,
    )
    enforcer.load_manifest(
        ToolManifest(connector="acme_kyb", tools={"resolve_business": Permission.READ})
    )
    try:
        if not enforcer.revocation_feed().ready(timeout=10.0):
            print("the revocation feed never became fresh", file=sys.stderr)
            return 1

        allowed = enforcer.enforce(pairs[0][1], "acme_kyb", "resolve_business")
        if not allowed.allowed:
            print(f"the child grant was denied before any revocation: {allowed.reason}", file=sys.stderr)
            return 1

        latencies: list[float] = []
        for parent_grant_id, child_token in pairs:
            started = time.time()
            admin.grants.revoke(parent_grant_id)
            denial: Any = None
            while time.time() - started < 30:
                result = enforcer.enforce(child_token, "acme_kyb", "resolve_business")
                if not result.allowed:
                    denial = result
                    break
                time.sleep(0.02)
            elapsed_ms = (time.time() - started) * 1000
            if denial is None:
                print(f"child grant still allowed {elapsed_ms:.0f} ms after revocation", file=sys.stderr)
                return 1
            if denial.reason_code != DenialReason.GRANT_REVOKED:
                print(f"unexpected denial: {denial.reason_code} {denial.reason}", file=sys.stderr)
                return 1
            if denial.sub_reason not in (
                RevocationSubReason.REVOKED,
                RevocationSubReason.PARENT_REVOKED,
            ):
                print(f"unexpected sub-reason: {denial.sub_reason}", file=sys.stderr)
                return 1
            latencies.append(elapsed_ms)
    finally:
        enforcer.stop_revocation_feed()

    report = {
        "trials": len(latencies),
        "budget_ms": BUDGET_MS,
        "min_ms": min(latencies),
        "p50_ms": _percentile(latencies, 0.5),
        "p95_ms": _percentile(latencies, 0.95),
        "max_ms": max(latencies),
        "latencies_ms": latencies,
    }
    print(f"revocation propagation (Python SDK): {json.dumps(report)}")
    if REPORT:
        with open(REPORT, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
            handle.write("\n")
    if report["p95_ms"] > BUDGET_MS:
        print(f"p95 {report['p95_ms']:.0f} ms is above the {BUDGET_MS:.0f} ms budget", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
