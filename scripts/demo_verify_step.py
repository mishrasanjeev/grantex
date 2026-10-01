# SPDX-License-Identifier: Apache-2.0
"""The relying party's side of Demo 2: sign a request as the agent, verify it
with grantex_verifier.verify(), print the decision as one JSON line.

The registry and the mock issuer advertise https origins and listen on
loopback; the relying party's ``fetch`` maps one to the other, which is the
only place the demo differs from a deployment. The registry lookup and the
grant status source are the relying party's own clients, authenticated with
GRANTEX_API_KEY where the route needs a key.

Exit status 0 when the decision matches ``--expect`` (``ok`` or ``denied``),
1 otherwise; the decision line is printed either way.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Mapping, Optional
from urllib.parse import quote

import httpx

from grantex_agent_httpsig import HttpRequest, sign
from grantex_verifier import InMemoryNonceStore, OnlineGrantStatus, Transaction, VerifierConfig, verify


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--registry-origin", required=True, help="the registry's public https origin (its issuer)")
    parser.add_argument("--registry-loopback", required=True, help="where the registry listens")
    parser.add_argument("--mock-origin", required=True, help="the mock issuer's https entity id")
    parser.add_argument("--mock-loopback", required=True, help="where the mock issuer listens")
    parser.add_argument("--passport", required=True, metavar="FILE")
    parser.add_argument("--grant", required=True, metavar="FILE")
    parser.add_argument("--agent-key", required=True, metavar="FILE", help="the agent's private JWK")
    parser.add_argument("--merchant", required=True, help="the relying party's origin")
    parser.add_argument("--audience", required=True, help="the grant audience the relying party expects")
    parser.add_argument("--amount-minor", type=int, default=12_500)
    parser.add_argument("--expect", choices=["ok", "denied"], required=True)
    args = parser.parse_args(argv)

    api_key = os.environ.get("GRANTEX_API_KEY")
    mapping = {args.registry_origin: args.registry_loopback, args.mock_origin: args.mock_loopback}

    def mapped(url: str) -> str:
        for origin, loopback in mapping.items():
            if url.startswith(origin):
                return loopback + url[len(origin):]
        return url

    client = httpx.Client(follow_redirects=False, timeout=10.0)

    def fetch(url: str) -> str:
        # The relying party reads manifests, JWK Sets and status lists over https
        # with no redirects; here the origins are mapped to loopback.
        response = client.get(mapped(url))
        response.raise_for_status()
        return response.text

    def registry_lookup(thumbprint: str) -> Optional[Mapping[str, Any]]:
        response = client.get(
            f"{args.registry_loopback}/v1/registry/agents?key_thumbprint={quote(thumbprint, safe='')}",
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        body: Dict[str, Any] = response.json()
        return body

    def status_get(path: str) -> Any:
        response = client.get(args.registry_loopback + path, headers={"Authorization": f"Bearer {api_key}"} if api_key else {})
        response.raise_for_status()
        return response.json()

    config = VerifierConfig(
        origin=args.merchant,
        audience=args.audience,
        registry_issuer=args.registry_origin,
        registry_jwks=args.registry_origin + "/.well-known/jwks.json",
        manifest_url=args.registry_origin + "/.well-known/agent-registry.json",
        fetch=fetch,
        registry_lookup=registry_lookup,
        grant_status=OnlineGrantStatus(status_get),
        nonce_store=InMemoryNonceStore(),
    )

    with open(args.passport, encoding="utf-8") as handle:
        passport = handle.read().strip()
    with open(args.grant, encoding="utf-8") as handle:
        grant = handle.read().strip()
    with open(args.agent_key, encoding="utf-8") as handle:
        agent_key = json.load(handle)

    # The agent's request, signed with the key the passport and the grant are bound to.
    body = json.dumps({"cart_id": "c-1001", "amount_minor": args.amount_minor, "currency": "EUR"}).encode()
    url = args.merchant + "/v1/checkout"
    headers = {"content-type": "application/json"}
    signed = sign(HttpRequest("POST", url, headers, body), key=agent_key, agent_passport=passport, agent_grant=grant)
    request = HttpRequest("POST", "/v1/checkout", {**headers, **signed.headers}, body)

    decision = verify(
        passport, grant, request,
        Transaction(amount_minor=args.amount_minor, currency="EUR", merchant=args.merchant),
        config=config,
    )
    printed = {
        "ok": decision.ok,
        "denial_code": decision.denial_code,
        "level": decision.level,
        "flags": list(decision.flags),
        "tier": decision.tier,
        "checks": {name: {"ok": c.ok, "code": c.code, "detail": c.detail} for name, c in decision.checks.items()},
    }
    sys.stdout.write(json.dumps(printed, sort_keys=True) + "\n")
    matched = decision.ok if args.expect == "ok" else not decision.ok
    return 0 if matched else 1


if __name__ == "__main__":
    sys.exit(main())
