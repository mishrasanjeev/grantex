from __future__ import annotations

from urllib.parse import quote

from .._http import HttpClient
from .._types import Anomaly, DetectAnomaliesResponse, ListAnomaliesResponse


class AnomaliesClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def get_response_policy(self) -> str:
        """Return the account's irregularity response mode."""
        data = self._http.get("/v1/irregularities/response-policy")
        return str(data["mode"])

    def set_response_policy(self, mode: str) -> str:
        """Select alert_only or revoke_agent_grants for the account."""
        if mode not in ("alert_only", "revoke_agent_grants"):
            raise ValueError("mode must be alert_only or revoke_agent_grants")
        data = self._http.patch("/v1/irregularities/response-policy", {"mode": mode})
        return str(data["mode"])

    def detect(self) -> DetectAnomaliesResponse:
        """Run anomaly detection across all agents and return detected anomalies."""
        data = self._http.post("/v1/anomalies/detect", {})
        return DetectAnomaliesResponse.from_dict(data)

    def list(self, *, unacknowledged: bool = False) -> ListAnomaliesResponse:
        """List stored anomalies. Pass unacknowledged=True to show only open ones."""
        path = "/v1/anomalies?unacknowledged=true" if unacknowledged else "/v1/anomalies"
        data = self._http.get(path)
        return ListAnomaliesResponse.from_dict(data)

    def acknowledge(self, anomaly_id: str) -> Anomaly:
        """Acknowledge an anomaly by ID."""
        data = self._http.patch(f"/v1/anomalies/{quote(anomaly_id, safe='')}/acknowledge", {})
        return Anomaly.from_dict(data)
