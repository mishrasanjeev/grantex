"""Tests for AnomaliesClient."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex

MOCK_ANOMALY = {
    "id": "anm_01",
    "type": "rate_spike",
    "severity": "high",
    "agentId": "ag_01",
    "principalId": None,
    "description": "Agent ag_01 performed 72 actions in the last hour (threshold: 50).",
    "metadata": {"count": 72, "windowHours": 1, "threshold": 50},
    "detectedAt": "2026-02-26T00:00:00Z",
    "acknowledgedAt": None,
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_detect(client: Grantex) -> None:
    respx.post("https://api.grantex.dev/v1/anomalies/detect").mock(
        return_value=httpx.Response(
            200,
            json={"detectedAt": "2026-02-26T00:00:00Z", "total": 1, "anomalies": [MOCK_ANOMALY]},
        )
    )
    result = client.anomalies.detect()

    assert result.total == 1
    assert result.anomalies[0].type == "rate_spike"
    assert result.anomalies[0].severity == "high"
    assert result.anomalies[0].agent_id == "ag_01"
    assert result.anomalies[0].principal_id is None
    assert result.anomalies[0].acknowledged_at is None


@respx.mock
def test_detect_empty(client: Grantex) -> None:
    respx.post("https://api.grantex.dev/v1/anomalies/detect").mock(
        return_value=httpx.Response(
            200,
            json={"detectedAt": "2026-02-26T00:00:00Z", "total": 0, "anomalies": []},
        )
    )
    result = client.anomalies.detect()
    assert result.total == 0
    assert len(result.anomalies) == 0


@respx.mock
def test_list(client: Grantex) -> None:
    route = respx.get("https://api.grantex.dev/v1/anomalies").mock(
        return_value=httpx.Response(200, json={"anomalies": [MOCK_ANOMALY], "total": 1})
    )
    result = client.anomalies.list()

    assert result.total == 1
    assert result.anomalies[0].id == "anm_01"
    url = str(route.calls[0].request.url)
    assert "unacknowledged" not in url


@respx.mock
def test_list_unacknowledged(client: Grantex) -> None:
    route = respx.get("https://api.grantex.dev/v1/anomalies").mock(
        return_value=httpx.Response(200, json={"anomalies": [], "total": 0})
    )
    client.anomalies.list(unacknowledged=True)

    url = str(route.calls[0].request.url)
    assert "unacknowledged=true" in url


@respx.mock
def test_acknowledge(client: Grantex) -> None:
    acked = {**MOCK_ANOMALY, "acknowledgedAt": "2026-02-26T01:00:00Z"}
    respx.patch("https://api.grantex.dev/v1/anomalies/anm_01/acknowledge").mock(
        return_value=httpx.Response(200, json=acked)
    )
    result = client.anomalies.acknowledge("anm_01")

    assert result.acknowledged_at == "2026-02-26T01:00:00Z"
    assert result.id == "anm_01"
