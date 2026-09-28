# SPDX-License-Identifier: Apache-2.0
"""RFC 9421 section 2.5 and Appendix B.2.

The signature bases rebuilt from the RFC's own messages and Signature-Input
values, and the B.2.4 (ECDSA P-256) and B.2.6 (Ed25519) signatures verified
with the RFC's public test keys.
"""

from __future__ import annotations

from typing import Any, Union

import pytest

from grantex_agent_httpsig import (
    AgentHttpSigError,
    HttpRequest,
    HttpResponse,
    Item,
    parse_dictionary,
    signature_base_for,
    verify_signature_value,
)

from .conftest import VECTORS


def _message(v: dict[str, Any]) -> Union[HttpRequest, HttpResponse]:
    m = v["message"]
    headers = [tuple(h) for h in m["headers"]] + [
        ("Signature-Input", v["signature_input"]),
        ("Signature", v["signature"]),
    ]
    if m["kind"] == "request":
        return HttpRequest(m["method"], m["url"], headers, m["body"])
    return HttpResponse(m["status"], headers, m["body"])


@pytest.mark.parametrize("v", VECTORS["rfc9421"], ids=lambda v: v["section"])
def test_signature_bases(v: dict[str, Any]) -> None:
    assert signature_base_for(_message(v), v["label"]) == v["signature_base"]


@pytest.mark.parametrize(
    "v", [v for v in VECTORS["rfc9421"] if "verify" in v], ids=lambda v: v["section"]
)
def test_signatures_with_the_rfc_test_keys(v: dict[str, Any]) -> None:
    member = parse_dictionary(v["signature"])[v["label"]]
    assert isinstance(member, Item) and isinstance(member.value, bytes)
    jwk = v["verify"]["public_jwk"]
    assert verify_signature_value(jwk, v["signature_base"], member.value) is True
    changed = v["signature_base"].replace("application/json", "application/jsoN")
    assert verify_signature_value(jwk, changed, member.value) is False


def _request(signature_input: str, *headers: tuple[str, str]) -> HttpRequest:
    return HttpRequest(
        "POST",
        "https://example.com/foo?param=Value&Pet=dog",
        [*headers, ("Signature-Input", signature_input)],
    )


@pytest.mark.parametrize(
    "request_",
    [
        # Section 2.5 step 2.1: a component that appears twice.
        _request('sig1=("@method" "@method");created=1'),
        # Step 2.5: a header field that is not in the message.
        _request('sig1=("date");created=1'),
        # A derived component it does not know.
        _request('sig1=("@unknown");created=1'),
        # Component parameters it does not implement.
        _request('sig1=("date";sf);created=1', ("Date", "x")),
        _request('sig1=("@query-param";name="Pet");created=1'),
        # Section 2.3: @signature-params is never a covered component.
        _request('sig1=("@signature-params");created=1'),
        # Section 2.2.9: @status is for responses.
        _request('sig1=("@status");created=1'),
        # Step 4: non-ASCII.
        _request('sig1=("x-name");created=1', ("X-Name", "café")),
    ],
)
def test_section_2_5_errors(request_: HttpRequest) -> None:
    with pytest.raises(AgentHttpSigError):
        signature_base_for(request_, "sig1")


def test_label_must_be_in_signature_input() -> None:
    with pytest.raises(AgentHttpSigError):
        signature_base_for(_request('sig1=("@method");created=1'), "sig2")


def test_query_and_scheme() -> None:
    base = signature_base_for(
        HttpRequest(
            "GET",
            "HTTPS://example.com/foo",
            [("Signature-Input", 'sig1=("@query" "@scheme");created=1')],
        ),
        "sig1",
    )
    assert base == (
        '"@query": ?\n"@scheme": https\n'
        '"@signature-params": ("@query" "@scheme");created=1'
    )


def test_field_lines_are_trimmed_and_combined() -> None:
    base = signature_base_for(
        HttpRequest(
            "GET",
            "https://example.com/",
            [
                ("Cache-Control", "  max-age=60 "),
                ("cache-control", "must-revalidate"),
                ("Signature-Input", 'sig1=("cache-control");created=1'),
            ],
        ),
        "sig1",
    )
    assert base == (
        '"cache-control": max-age=60, must-revalidate\n'
        '"@signature-params": ("cache-control");created=1'
    )
