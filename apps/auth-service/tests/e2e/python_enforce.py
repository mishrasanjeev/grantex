"""Python SDK side of decision-grants-browser.e2e.test.ts.

Calls ``enforce()`` twice against the live auth service with the same decision
grants and prints both results as JSON: the first call consumes the grants,
the second is a replay.
"""

import json
import os

from grantex import Grantex, ToolManifest

# Offline revocation check: this is about decision grants, and the other
# agent's grant token is known only to its signature (no grant row), so an
# online check would deny it as unknown before the decision grant is read.
client = Grantex(
    api_key=os.environ["GRANTEX_API_KEY"],
    base_url=os.environ["GRANTEX_E2E_BASE_URL"],
    max_retries=0,
    revocation_check="offline",
)
client.load_manifest(ToolManifest.from_dict({
    "connector": "acme_kyb",
    "tools": {"case_decision": {"permission": "write", "requires_decision": True, "four_eyes_on": ["decline"]}},
}))

results = []
for _ in range(2):
    result = client.enforce(
        os.environ["GRANTEX_E2E_GRANT_TOKEN"],
        "acme_kyb",
        "case_decision",
        decision_grants=os.environ["GRANTEX_E2E_DECISION_GRANTS"].split(","),
        arguments=json.loads(os.environ["GRANTEX_E2E_ARGUMENTS"]),
        case_version="v1",
    )
    results.append({"allowed": result.allowed, "reason_code": result.reason_code, "sub_reason": result.sub_reason, "reason": result.reason})
print(json.dumps(results))
