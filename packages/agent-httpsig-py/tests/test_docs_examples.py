# SPDX-License-Identifier: Apache-2.0
"""The Python example in spec/verification.md and this package's README.

The example is tests/docs/examples/sign_and_verify.py, embedded verbatim
(without its SPDX line) and run here.
"""

from __future__ import annotations

import re

from sign_and_verify import sign_and_verify

from .conftest import REPO_ROOT

EXAMPLE = "packages/agent-httpsig-py/tests/docs/examples/sign_and_verify.py"
SNIPPET = re.compile(r"<!-- snippet: (\S+) -->\n```python\n(.*?)\n```", re.S)


def _read(path: str) -> str:
    # Compare with LF line endings whatever the checkout's autocrlf setting.
    return (REPO_ROOT / path).read_text(encoding="utf-8").replace("\r", "")


def _without_spdx(code: str) -> str:
    return re.sub(r"^# SPDX-License-Identifier: [^\n]*\n", "", code).rstrip("\n")


def test_spec_embeds_the_example_verbatim() -> None:
    found = SNIPPET.findall(_read("spec/verification.md"))
    assert [path for path, _ in found] == [EXAMPLE]
    assert found[0][1] == _without_spdx(_read(EXAMPLE))


def test_readme_embeds_the_example_verbatim_and_says_it_is_unpublished() -> None:
    readme = _read("packages/agent-httpsig-py/README.md")
    found = SNIPPET.findall(readme)
    assert [path for path, _ in found] == [EXAMPLE]
    assert found[0][1] == _without_spdx(_read(EXAMPLE))
    assert readme.count("```python") == 1
    assert re.search(r"not yet published", readme, re.I)


def test_the_example_signs_and_verifies() -> None:
    result = sign_and_verify("passport-placeholder.shopper-01", "grant-placeholder.shopper-01")
    assert result.ok
    assert result.agent_passport == "passport-placeholder.shopper-01"
