import threading
import time
from unittest.mock import patch

import pytest
from grantex.resources._events import EventsClient, GrantexEvent, StreamOptions, Subscription


class TestGrantexEvent:
    def test_from_dict(self):
        d = {"id": "evt_1", "type": "grant.created", "createdAt": "2026-03-01T00:00:00Z", "data": {"grantId": "grnt_1"}}
        event = GrantexEvent.from_dict(d)
        assert event.id == "evt_1"
        assert event.type == "grant.created"
        assert event.created_at == "2026-03-01T00:00:00Z"
        assert event.data == {"grantId": "grnt_1"}

    def test_from_dict_missing_data(self):
        d = {"id": "evt_1", "type": "grant.created", "createdAt": "2026-03-01T00:00:00Z"}
        event = GrantexEvent.from_dict(d)
        assert event.data == {}

    def test_frozen(self):
        event = GrantexEvent(id="evt_1", type="grant.created", created_at="2026-03-01T00:00:00Z", data={})
        with pytest.raises(AttributeError):
            event.id = "other"


class TestStreamOptions:
    def test_defaults(self):
        opts = StreamOptions()
        assert opts.types is None

    def test_with_types(self):
        opts = StreamOptions(types=["grant.created", "token.issued"])
        assert opts.types == ["grant.created", "token.issued"]


def _make_events(count: int) -> list[GrantexEvent]:
    """Helper to create a list of test events."""
    return [
        GrantexEvent(
            id=f"evt_{i}",
            type="grant.created",
            created_at="2026-03-01T00:00:00Z",
            data={"n": i},
        )
        for i in range(count)
    ]


class TestEventsClient:
    def test_constructor(self):
        client = EventsClient("https://api.grantex.dev", "test-key")
        assert client._base_url == "https://api.grantex.dev"
        assert client._api_key == "test-key"


class TestSubscription:
    def test_active_property(self):
        stop = threading.Event()
        stop.set()  # thread will exit immediately
        t = threading.Thread(target=lambda: None, daemon=True)
        t.start()
        t.join()
        sub = Subscription(thread=t, stop_event=stop)
        assert sub.active is False

    def test_unsubscribe_sets_stop(self):
        stop = threading.Event()
        t = threading.Thread(target=lambda: stop.wait(), daemon=True)
        t.start()
        sub = Subscription(thread=t, stop_event=stop)
        assert sub.active is True
        sub.unsubscribe()
        assert stop.is_set()
        assert sub.active is False


class TestSubscribe:
    def test_subscribe_receives_events(self):
        """subscribe() should deliver every event from stream() to the handler."""
        events = _make_events(3)
        client = EventsClient("https://api.grantex.dev", "test-key")

        with patch.object(client, "stream", return_value=iter(events)):
            received: list[GrantexEvent] = []
            sub = client.subscribe(lambda e: received.append(e))
            # Wait for the background thread to finish consuming the iterator
            sub._thread.join(timeout=2)

        assert received == events

    def test_subscribe_with_options(self):
        """subscribe() should forward StreamOptions to stream()."""
        events = _make_events(1)
        client = EventsClient("https://api.grantex.dev", "test-key")
        opts = StreamOptions(types=["grant.created"])

        with patch.object(client, "stream", return_value=iter(events)) as mock_stream:
            sub = client.subscribe(lambda e: None, options=opts)
            sub._thread.join(timeout=2)
            mock_stream.assert_called_once_with(opts)

    def test_unsubscribe_stops_stream(self):
        """unsubscribe() should stop processing events mid-stream."""
        client = EventsClient("https://api.grantex.dev", "test-key")
        received: list[GrantexEvent] = []
        barrier = threading.Event()

        def slow_generator():
            for evt in _make_events(10):
                yield evt
                # After yielding each event, give the test a chance to unsubscribe
                barrier.wait(timeout=2)
                barrier.clear()

        with patch.object(client, "stream", return_value=slow_generator()):
            sub = client.subscribe(lambda e: received.append(e))
            # Wait for first event to be processed
            for _ in range(50):
                if len(received) >= 1:
                    break
                time.sleep(0.01)
            # Unsubscribe after the first event
            sub.unsubscribe()
            barrier.set()  # unblock generator in case it's waiting

        # Should have received at most a couple of events, not all 10
        assert 1 <= len(received) < 10

    def test_subscribe_error_calls_on_error(self):
        """When stream() raises, the on_error callback should be invoked."""
        client = EventsClient("https://api.grantex.dev", "test-key")
        error_holder: list[Exception] = []

        def failing_stream(options=None):
            raise ConnectionError("SSE connection lost")

        with patch.object(client, "stream", side_effect=failing_stream):
            sub = client.subscribe(
                lambda e: None,
                on_error=lambda exc: error_holder.append(exc),
            )
            sub._thread.join(timeout=2)

        assert len(error_holder) == 1
        assert isinstance(error_holder[0], ConnectionError)
        assert "SSE connection lost" in str(error_holder[0])

    def test_subscribe_error_no_callback_swallowed(self):
        """When stream() raises and no on_error is given, the error is silently swallowed."""
        client = EventsClient("https://api.grantex.dev", "test-key")

        def failing_stream(options=None):
            raise RuntimeError("boom")

        with patch.object(client, "stream", side_effect=failing_stream):
            sub = client.subscribe(lambda e: None)
            sub._thread.join(timeout=2)

        # Thread exited cleanly without propagating
        assert sub.active is False

    def test_subscribe_returns_subscription(self):
        """subscribe() should return a Subscription instance."""
        client = EventsClient("https://api.grantex.dev", "test-key")

        with patch.object(client, "stream", return_value=iter([])):
            sub = client.subscribe(lambda e: None)
            assert isinstance(sub, Subscription)
            sub._thread.join(timeout=2)
