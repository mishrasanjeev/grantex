from __future__ import annotations

from .._http import HttpClient
from .._types import Anomaly, DetectAnomaliesResponse, ListAnomaliesResponse


class AnomaliesClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

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
        data = self._http.patch(f"/v1/anomalies/{anomaly_id}/acknowledge", {})
        return Anomaly.from_dict(data)
