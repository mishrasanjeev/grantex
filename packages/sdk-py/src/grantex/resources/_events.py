from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterator, Optional, Sequence
import json
import httpx


@dataclass(frozen=True)
class GrantexEvent:
    id: str
    type: str
    created_at: str
    data: dict[str, Any]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "GrantexEvent":
        return cls(
            id=d["id"],
            type=d["type"],
            created_at=d["createdAt"],
            data=d.get("data", {}),
        )


@dataclass(frozen=True)
class StreamOptions:
    types: Optional[Sequence[str]] = None


class EventsClient:
    def __init__(self, base_url: str, api_key: str) -> None:
        self._base_url = base_url
        self._api_key = api_key

    def stream(self, options: Optional[StreamOptions] = None) -> Iterator[GrantexEvent]:
        """Connect to the SSE event stream. Yields GrantexEvent objects."""
        params = {}
        if options and options.types:
            params["types"] = ",".join(options.types)

        url = f"{self._base_url}/v1/events/stream"
        with httpx.stream(
            "GET",
            url,
            params=params,
            headers={"Authorization": f"Bearer {self._api_key}"},
            timeout=None,
        ) as response:
            response.raise_for_status()
            buffer = ""
            for chunk in response.iter_text():
                buffer += chunk
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    if line.startswith("data: "):
                        try:
                            data = json.loads(line[6:])
                            yield GrantexEvent.from_dict(data)
                        except (json.JSONDecodeError, KeyError):
                            pass
