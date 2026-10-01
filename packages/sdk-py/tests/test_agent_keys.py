"""AgentKeysClient: the key history routes, URL and body for each."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from grantex import Grantex

BASE = "https://api.grantex.dev"
AGENT = "ag_01HXYZ123abc"
TP = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"
KEY = {
    "thumbprint": TP, "agentId": AGENT, "jwk": {"kty": "EC", "crv": "P-256", "x": "x", "y": "y"}, "alg": "ES256",
    "status": "pending", "validFrom": "2026-09-30T00:00:00.000Z", "validTo": None, "possessionProvedAt": None,
    "rotatedFrom": None, "createdAt": "2026-09-30T00:00:00.000Z", "usable": False, "denial": "key_unproven",
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key", revocation_check="offline")


@respx.mock
def test_list_reads_the_history(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/agents/{AGENT}/keys").mock(return_value=httpx.Response(200, json={"keys": [KEY]}))
    keys = client.agents.keys.list(AGENT)
    assert len(keys) == 1 and keys[0].thumbprint == TP and keys[0].status == "pending"
    assert keys[0].usable is False and keys[0].denial == "key_unproven"


@respx.mock
def test_list_accepts_a_bare_array(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/agents/{AGENT}/keys").mock(return_value=httpx.Response(200, json=[KEY]))
    assert client.agents.keys.list(AGENT)[0].agent_id == AGENT


@respx.mock
def test_add_posts_the_public_jwk(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/agents/{AGENT}/keys").mock(return_value=httpx.Response(201, json=KEY))
    key = client.agents.keys.add(AGENT, {"kty": "EC", "crv": "P-256", "x": "x", "y": "y"})
    assert json.loads(route.calls[0].request.content) == {"publicJwk": {"kty": "EC", "crv": "P-256", "x": "x", "y": "y"}}
    assert key.thumbprint == TP


@respx.mock
def test_challenge_and_prove(client: Grantex) -> None:
    challenge = {
        "thumbprint": TP, "challenge": "n" * 43, "audience": "https://grantex.dev", "subject": AGENT,
        "typ": "agent-key-proof+jwt", "alg": "ES256", "expiresAt": "2026-09-30T00:05:00.000Z",
    }
    respx.post(f"{BASE}/v1/agents/{AGENT}/keys/{TP}/challenge").mock(return_value=httpx.Response(201, json=challenge))
    proved = {**KEY, "status": "active", "possessionProvedAt": "2026-09-30T00:01:00.000Z", "usable": True, "denial": None}
    prove = respx.post(f"{BASE}/v1/agents/{AGENT}/keys/{TP}/prove").mock(return_value=httpx.Response(200, json=proved))

    issued = client.agents.keys.challenge(AGENT, TP)
    assert issued.challenge == "n" * 43 and issued.audience == "https://grantex.dev" and issued.alg == "ES256"
    key = client.agents.keys.prove(AGENT, TP, "h.p.s")
    assert json.loads(prove.calls[0].request.content) == {"proof": "h.p.s"}
    assert key.status == "active" and key.usable is True and key.possession_proved_at == "2026-09-30T00:01:00.000Z"


@respx.mock
def test_rotate_and_compromise_bodies(client: Grantex) -> None:
    rotate = respx.post(f"{BASE}/v1/agents/{AGENT}/keys/{TP}/rotate").mock(return_value=httpx.Response(200, json={"rotated": KEY}))
    compromise = respx.post(f"{BASE}/v1/agents/{AGENT}/keys/{TP}/compromise").mock(return_value=httpx.Response(200, json={"key": KEY}))
    assert "rotated" in client.agents.keys.rotate(AGENT, TP, "k" * 43, overlap_seconds=3600)
    assert json.loads(rotate.calls[0].request.content) == {"replacementThumbprint": "k" * 43, "overlapSeconds": 3600}
    assert "key" in client.agents.keys.compromise(AGENT, TP, reason="laptop lost")
    assert json.loads(compromise.calls[0].request.content) == {"reason": "laptop lost"}


@respx.mock
def test_thumbprints_are_url_encoded(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/agents/ag%2Fx/keys/a%2Fb/challenge").mock(
        return_value=httpx.Response(201, json={"thumbprint": "a/b", "challenge": "c", "audience": "a", "subject": "s", "typ": "t", "alg": "ES256"})
    )
    client.agents.keys.challenge("ag/x", "a/b")
    assert route.called
