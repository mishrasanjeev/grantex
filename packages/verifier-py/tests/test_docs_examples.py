# SPDX-License-Identifier: Apache-2.0
"""The examples in docs/relying-parties/verifying-agents.md and the README.

Each is a file under tests/docs/examples, embedded verbatim (without its SPDX
line) and run here against the fake registry.
"""

from __future__ import annotations

import io
import re
import time

from conftest import REPO_ROOT, World
from verify_checkout import make_config, verify_checkout
from wsgi_app import build_app

EXAMPLES = [
    "packages/verifier-py/tests/docs/examples/verify_checkout.py",
    "packages/verifier-py/tests/docs/examples/wsgi_app.py",
]
SNIPPET = re.compile(r"<!-- snippet: (\S+) -->\n```python\n(.*?)\n```", re.S)
# The guide is published as MDX, which has no HTML comments, so it marks
# each snippet with an MDX comment instead.
GUIDE_SNIPPET = re.compile(r"\{/\* snippet: (\S+) \*/\}\n```python\n(.*?)\n```", re.S)


def _read(path: str) -> str:
    # Compare with LF line endings whatever the checkout's autocrlf setting.
    return (REPO_ROOT / path).read_text(encoding="utf-8").replace("\r", "")


def _without_spdx(code: str) -> str:
    return re.sub(r"^# SPDX-License-Identifier: [^\n]*\n", "", code).rstrip("\n")


def test_the_guide_embeds_the_examples_verbatim() -> None:
    found = GUIDE_SNIPPET.findall(_read("docs/relying-parties/verifying-agents.md"))
    assert [path for path, _ in found] == EXAMPLES
    for path, code in found:
        assert code == _without_spdx(_read(path))


def test_the_readme_embeds_the_examples_verbatim_and_says_it_is_unpublished() -> None:
    readme = _read("packages/verifier-py/README.md")
    found = SNIPPET.findall(readme)
    assert [path for path, _ in found] == EXAMPLES
    for path, code in found:
        assert code == _without_spdx(_read(path))
    assert re.search(r"not yet published", readme, re.I)


def test_the_verify_example_accepts_a_good_request() -> None:
    # The example keeps the real clock, so this world is built at the real time.
    world = World(now=float(int(time.time())))
    req, _, _ = world.signed_request()
    config = make_config(fetch=world.fetcher, registry_lookup=world.lookup, grant_status=world.grant_status)
    result = verify_checkout(req, config=config)
    assert result.ok, result.denial_code


def test_the_verify_example_refuses_a_replayed_request() -> None:
    # The example's configuration is built once and kept, so its nonce store
    # sees the second presentation of the same signed request.
    world = World(now=float(int(time.time())))
    req, _, _ = world.signed_request()
    config = make_config(fetch=world.fetcher, registry_lookup=world.lookup, grant_status=world.grant_status)
    assert verify_checkout(req, config=config).ok
    again = verify_checkout(req, config=config)
    assert not again.ok
    assert again.denial_code == "request_signature_invalid"
    assert "nonce" in again.checks["request.signature"].detail


def test_the_wsgi_example_accepts_and_refuses(world: World) -> None:
    from test_middleware import call_wsgi, environ_for

    req, _, _ = world.signed_request()
    status, body = call_wsgi(build_app(world.config()), environ_for(req))
    assert status.startswith("200"), body
    assert body == b"accepted at level attested"
    world.grant_status.state = "revoked"
    req, _, _ = world.signed_request()
    environ = environ_for(req)
    status, body = call_wsgi(build_app(world.config()), environ)
    assert status.startswith("403")
    assert isinstance(environ["wsgi.input"], io.BytesIO)


def test_the_spec_lists_exactly_the_constraint_members_the_verifier_reads(world: World) -> None:
    from conftest import tx

    from grantex_verifier import verify
    from grantex_verifier._verify import CONSTRAINT_MEMBERS

    spec = _read("spec/verification.md")
    section = spec.split("### 7.5", 1)[1].split("### 7.6", 1)[0]
    members = set(re.findall(r"^\| `([a-z_]+)` \|", section, re.M))
    assert members == set(CONSTRAINT_MEMBERS)
    # A grant carrying every member, as the table describes them, verifies.
    constraints = world.commerce_entry()["constraints"]
    constraints["hitl_threshold_minor"] = 20_000
    grant = world.grant(authorization_details=[world.commerce_entry(constraints=constraints)])
    req, passport, _ = world.signed_request(grant=grant)
    result = verify(passport, grant, req, tx(), config=world.config())
    assert result.ok, result.denial_code
    assert result.tier == "B"
