from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterator, Optional, Sequence
import json
import threading

import httpx


EventHandler = Callable[["GrantexEvent"], None]
ErrorHandler = Callable[[Exception], None]


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


class Subscription:
    """Handle returned by ``EventsClient.subscribe`` to control the background stream."""

    def __init__(self, thread: threading.Thread, stop_event: threading.Event) -> None:
        self._thread = thread
        self._stop_event = stop_event

    @property
    def active(self) -> bool:
        """Return ``True`` if the subscription is still running."""
        return self._thread.is_alive()

    def unsubscribe(self) -> None:
        """Stop the background stream and wait for the thread to exit."""
        self._stop_event.set()
        self._thread.join(timeout=5)


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

    def subscribe(
        self,
        handler: EventHandler,
        options: Optional[StreamOptions] = None,
        *,
        on_error: Optional[ErrorHandler] = None,
    ) -> Subscription:
        """Subscribe to events with a callback handler.

        Starts a background thread that calls ``stream()`` and invokes
        *handler* for each event.  Returns a :class:`Subscription` whose
        ``unsubscribe()`` method stops the thread.

        Args:
            handler: Called with each :class:`GrantexEvent` received.
            options: Optional :class:`StreamOptions` to filter event types.
            on_error: Optional callback invoked when the stream raises an
                exception.  If not provided, errors are silently swallowed
                and the stream stops.
        """
        stop = threading.Event()

        def _run() -> None:
            try:
                for event in self.stream(options):
                    if stop.is_set():
                        break
                    handler(event)
            except Exception as exc:  # noqa: BLE001
                if on_error is not None:
                    on_error(exc)

        thread = threading.Thread(target=_run, daemon=True)
        thread.start()
        return Subscription(thread=thread, stop_event=stop)
