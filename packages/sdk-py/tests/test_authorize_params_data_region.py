# SPDX-License-Identifier: Apache-2.0
"""``AuthorizeParams.data_region`` is sent as ``dataRegion``."""
from grantex import AuthorizeParams


def test_data_region_is_sent_when_given() -> None:
    body = AuthorizeParams(agent_id="ag_1", user_id="shopper-01", scopes=["tool:acme_kyb:read"], data_region="in").to_dict()
    assert body["dataRegion"] == "in"
    assert "dataRegion" not in AuthorizeParams(agent_id="ag_1", user_id="shopper-01", scopes=["tool:acme_kyb:read"]).to_dict()
