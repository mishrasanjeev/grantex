"""Tests for all pre-built manifests."""
import importlib
import pytest

CONNECTORS = [
    "banking_aa", "gstn", "netsuite", "oracle_fusion", "quickbooks", "sap",
    "stripe", "tally", "zoho_books", "pinelabs_plural", "income_tax_india",
    "darwinbox", "docusign", "epfo", "greenhouse", "keka", "linkedin_talent",
    "okta", "zoom", "salesforce", "hubspot", "mailchimp", "google_ads",
    "meta_ads", "linkedin_ads", "ga4", "mixpanel", "moengage", "ahrefs",
    "bombora", "brandwatch", "buffer", "g2", "trustradius", "wordpress",
    "jira", "confluence", "servicenow", "zendesk", "pagerduty",
    "sanctions_api", "mca_portal", "gmail", "slack", "github",
    "google_calendar", "s3", "sendgrid", "twilio", "twitter", "whatsapp",
    "youtube", "langsmith",
]

VALID_PERMISSIONS = {"read", "write", "delete", "admin"}


@pytest.mark.parametrize("connector", CONNECTORS)
def test_manifest_loads(connector: str) -> None:
    mod = importlib.import_module(f"grantex.manifests.{connector}")
    assert hasattr(mod, "manifest")


@pytest.mark.parametrize("connector", CONNECTORS)
def test_manifest_has_correct_connector_name(connector: str) -> None:
    mod = importlib.import_module(f"grantex.manifests.{connector}")
    # Connector name should match filename (with underscores/hyphens)
    assert mod.manifest.connector == connector.replace("_", "_")


@pytest.mark.parametrize("connector", CONNECTORS)
def test_manifest_has_tools(connector: str) -> None:
    mod = importlib.import_module(f"grantex.manifests.{connector}")
    assert mod.manifest.tool_count >= 1


@pytest.mark.parametrize("connector", CONNECTORS)
def test_manifest_tools_have_valid_permissions(connector: str) -> None:
    mod = importlib.import_module(f"grantex.manifests.{connector}")
    for tool_name, perm in mod.manifest.tools.items():
        assert perm in VALID_PERMISSIONS, f"{connector}.{tool_name} has invalid permission: {perm}"


def test_total_manifest_count() -> None:
    assert len(CONNECTORS) == 53
