"""Behaviour of create_grantex_tool, get_tool_scopes and the package errors."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, call

import pytest
from conftest import READ_ONLY, READ_WRITE, FakeVerifier, synthetic_token

from grantex_strands import (
    GrantexStrandsError,
    ScopeViolationError,
    create_grantex_tool,
    get_tool_scopes,
)
from grantex_strands._jwt import decode_jwt_payload
from grantex_strands._tool import DEFAULT_JWKS_URI


def build(**overrides: Any) -> Any:
    settings: dict[str, Any] = {
        "name": "lookup",
        "description": "Look something up.",
        "grant_token": READ_ONLY,
        "required_scope": "data:read",
        "func": lambda **_: "result",
    }
    settings.update(overrides)
    return create_grantex_tool(**settings)


def service(allowed: Any = True, reason: str = "", as_dict: bool = False) -> MagicMock:
    client = MagicMock()
    decision: Any = {"allowed": allowed, "reason": reason} if as_dict else SimpleNamespace(
        allowed=allowed, reason=reason
    )
    client.enforce.return_value = decision
    return client


# --- verified mode (default) -------------------------------------------------


def test_built_tool_carries_name_and_description() -> None:
    tool = build(name="list_files", description="List the files in a folder.")
    assert callable(tool)
    assert (tool.name, tool.description) == ("list_files", "List the files in a folder.")


def test_call_passes_keyword_arguments_through_and_returns_the_result() -> None:
    seen: list[dict[str, Any]] = []

    def fetch(**kwargs: Any) -> str:
        seen.append(kwargs)
        return "page:" + kwargs["url"]

    tool = build(grant_token=READ_WRITE, func=fetch)
    assert tool(url="https://merchant.example/catalog") == "page:https://merchant.example/catalog"
    assert seen == [{"url": "https://merchant.example/catalog"}]


@pytest.mark.parametrize(
    ("token", "scope", "allowed"),
    [
        (READ_ONLY, "data:read", True),
        (READ_WRITE, "data:write", True),
        (READ_ONLY, "data:write", False),
        (READ_ONLY, "admin:all", False),
    ],
)
def test_scope_is_required_when_the_tool_is_built(token: str, scope: str, allowed: bool) -> None:
    callback = MagicMock(return_value="done")
    if allowed:
        assert build(grant_token=token, required_scope=scope, func=callback)() == "done"
        return
    with pytest.raises(PermissionError) as info:
        build(grant_token=token, required_scope=scope, func=callback)
    assert str(info.value) == (
        f"Grant token is missing required scope '{scope}'. Granted scopes: ['data:read']"
    )
    callback.assert_not_called()


def test_unverifiable_token_is_a_value_error(verifier: FakeVerifier) -> None:
    verifier.failure = "bad signature"
    with pytest.raises(ValueError, match="^Could not verify grant_token: bad signature$"):
        build()


def test_malformed_token_is_a_value_error() -> None:
    with pytest.raises(ValueError, match="Could not verify grant_token"):
        build(grant_token="not.a.valid-jwt-payload")


def test_every_call_verifies_again(verifier: FakeVerifier) -> None:
    callback = MagicMock(return_value="ok")
    tool = build(func=callback)
    assert tool() == "ok"
    verifier.failure = "token revoked"
    with pytest.raises(ValueError, match="token revoked"):
        tool()
    assert callback.call_count == 1
    assert len(verifier.calls) == 3


def test_verification_options_mirror_the_arguments(verifier: FakeVerifier) -> None:
    authority = MagicMock()
    build(
        issuer="https://issuer.example",
        issuer_did="did:web:issuer.example",
        audience="https://api.merchant.example",
        clock_tolerance=30,
        current_authority=authority,
        expected_principal_id="principal-01",
        expected_agent_did="did:grantex:shopper-01",
    )
    token, options = verifier.calls[0]
    assert token == READ_ONLY
    assert options.jwks_uri == DEFAULT_JWKS_URI == "https://api.grantex.dev/.well-known/jwks.json"
    assert options.issuer == "https://issuer.example"
    assert options.issuer_did == "did:web:issuer.example"
    assert options.audience == "https://api.merchant.example"
    assert options.clock_tolerance == 30
    assert options.current_authority is authority
    assert options.expected_principal_id == "principal-01"
    assert options.expected_agent_did == "did:grantex:shopper-01"


def test_custom_jwks_uri_is_used(verifier: FakeVerifier) -> None:
    build(jwks_uri="https://issuer.example/jwks.json")
    assert verifier.calls[0][1].jwks_uri == "https://issuer.example/jwks.json"


# --- online mode ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("missing", "message"),
    [
        ("client", "online=True requires a 'client' (Grantex instance)"),
        ("connector", "online=True requires a 'connector' name"),
    ],
)
def test_online_mode_needs_client_and_connector(missing: str, message: str) -> None:
    settings: dict[str, Any] = {"online": True, "client": service(), "connector": "files"}
    settings[missing] = None
    with pytest.raises(ValueError) as info:
        build(**settings)
    assert str(info.value) == message


def test_online_mode_asks_the_service_at_build_and_at_each_call(verifier: FakeVerifier) -> None:
    client = service()
    tool = build(name="read_files", online=True, client=client, connector="files")
    assert tool() == "result"
    assert client.enforce.call_args_list == [
        call(READ_ONLY, "files", "read_files"),
        call(READ_ONLY, "files", "read_files"),
    ]
    # An unbound online tool relies on the service alone.
    assert verifier.calls == []


def test_online_mode_forwards_the_audience_keyword() -> None:
    client = service()
    tool = build(
        name="read_files",
        online=True,
        client=client,
        connector="files",
        audience="https://api.merchant.example",
    )
    tool()
    expected = call(READ_ONLY, "files", "read_files", audience="https://api.merchant.example")
    assert client.enforce.call_args_list == [expected, expected]


@pytest.mark.parametrize("as_dict", [False, True])
def test_online_refusal_reports_the_service_reason(as_dict: bool) -> None:
    client = service(allowed=False, reason="audience does not include the relying party", as_dict=as_dict)
    callback = MagicMock()
    with pytest.raises(PermissionError) as info:
        build(name="read_files", online=True, client=client, connector="files", func=callback)
    assert str(info.value) == (
        "Grant token scope check failed for tool 'read_files' on connector 'files': "
        "audience does not include the relying party"
    )
    callback.assert_not_called()


def test_dict_shaped_service_answers_are_accepted() -> None:
    client = service(as_dict=True)
    assert build(online=True, client=client, connector="files")() == "result"


def test_dict_answer_without_reason_reports_an_empty_reason() -> None:
    client = MagicMock()
    client.enforce.return_value = {"allowed": False}
    with pytest.raises(PermissionError, match="connector 'files': $"):
        build(name="read_files", online=True, client=client, connector="files")


@pytest.mark.parametrize("allowed", ["true", "false", 1, 0, None, False])
def test_only_a_literal_true_allows(allowed: Any) -> None:
    callback = MagicMock()
    with pytest.raises(PermissionError):
        build(online=True, client=service(allowed=allowed), connector="files", func=callback)
    callback.assert_not_called()


def test_service_refusal_at_call_time_blocks_the_callback() -> None:
    client = service()
    callback = MagicMock(return_value="ok")
    tool = build(online=True, client=client, connector="files", func=callback)
    client.enforce.return_value = SimpleNamespace(allowed=False, reason="grant revoked")
    with pytest.raises(PermissionError, match="grant revoked"):
        tool()
    callback.assert_not_called()


@pytest.mark.parametrize(
    "binding",
    [
        {"current_authority": MagicMock()},
        {"expected_principal_id": "principal-01"},
        {"expected_agent_did": "did:grantex:shopper-01"},
    ],
)
def test_bound_online_tool_verifies_at_build_without_using_the_service(
    binding: dict[str, Any], verifier: FakeVerifier
) -> None:
    client = service()
    tool = build(online=True, client=client, connector="files", audience="files-api", **binding)
    client.enforce.assert_not_called()
    assert len(verifier.calls) == 1

    assert tool() == "result"
    client.enforce.assert_called_once_with(READ_ONLY, "files", "lookup", audience="files-api")
    assert len(verifier.calls) == 2


def test_bound_online_tool_without_the_scope_fails_before_the_service() -> None:
    client = service()
    with pytest.raises(PermissionError, match="missing required scope 'data:write'"):
        build(
            required_scope="data:write",
            online=True,
            client=client,
            connector="files",
            expected_principal_id="principal-01",
        )
    client.enforce.assert_not_called()


def test_bound_online_call_stops_on_local_failure(verifier: FakeVerifier) -> None:
    client = service()
    callback = MagicMock()
    tool = build(online=True, client=client, connector="files", func=callback, current_authority=MagicMock())
    verifier.failure = "authority withdrawn"
    with pytest.raises(ValueError, match="authority withdrawn"):
        tool()
    client.enforce.assert_not_called()
    callback.assert_not_called()


# --- get_tool_scopes and token decoding ---------------------------------------


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        (READ_WRITE, ["data:read", "data:write"]),
        (synthetic_token([]), []),
        (synthetic_token("data:read"), []),
        (synthetic_token(None), []),
        ("garbage", []),
        ("a.%%%.c", []),
        ("a.W10.c", []),
    ],
)
def test_get_tool_scopes(token: str, expected: list[str]) -> None:
    assert get_tool_scopes(token) == expected


def test_get_tool_scopes_without_scp_claim() -> None:
    token = synthetic_token(["x"])
    header, _, signature = token.split(".")
    stripped = ".".join([header, "eyJzdWIiOiJwcmluY2lwYWwtMDEifQ", signature])
    assert get_tool_scopes(stripped) == []


@pytest.mark.parametrize("token", ["one", "one.two", "a.b.c.d"])
def test_decode_rejects_wrong_segment_counts(token: str) -> None:
    with pytest.raises(ValueError, match=r"^Invalid JWT: expected 3 parts separated by '\.'$"):
        decode_jwt_payload(token)


@pytest.mark.parametrize("subject", ["a", "ab", "abc", "abcd"])
def test_decode_restores_any_padding_length(subject: str) -> None:
    assert decode_jwt_payload(synthetic_token(["s"], sub=subject))["sub"] == subject


# --- errors ----------------------------------------------------------------------


def test_scope_violation_error_reports_both_sides() -> None:
    err = ScopeViolationError("data:write", ["data:read"])
    assert isinstance(err, GrantexStrandsError)
    assert (err.required_scope, err.granted_scopes) == ("data:write", ["data:read"])
    assert str(err) == "Grant token is missing required scope 'data:write'. Granted scopes: ['data:read']"
