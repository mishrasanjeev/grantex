import pytest
from grantex.resources._events import EventsClient, GrantexEvent, StreamOptions


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


class TestEventsClient:
    def test_constructor(self):
        client = EventsClient("https://api.grantex.dev", "test-key")
        assert client._base_url == "https://api.grantex.dev"
        assert client._api_key == "test-key"
