"""Tests for SsoClient — legacy and enterprise SSO methods."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex
from grantex._types import (
    CreateSsoConfigParams,
    CreateSsoConnectionParams,
    SsoEnforcementParams,
    SsoLdapCallbackParams,
    SsoOidcCallbackParams,
    SsoSamlCallbackParams,
    UpdateSsoConnectionParams,
)

BASE = "https://api.grantex.dev"

MOCK_SSO_CONFIG = {
    "issuerUrl": "https://idp.example.com",
    "clientId": "client_abc",
    "redirectUri": "https://app.grantex.dev/sso/callback",
    "createdAt": "2026-02-27T00:00:00Z",
    "updatedAt": "2026-02-27T00:00:00Z",
}

MOCK_CONNECTION = {
    "id": "sso_conn_01",
    "developerId": "dev_TEST",
    "name": "Okta OIDC",
    "protocol": "oidc",
    "status": "active",
    "issuerUrl": "https://idp.example.com",
    "clientId": "client_abc",
    "domains": ["example.com"],
    "jitProvisioning": True,
    "enforce": False,
    "groupAttribute": "groups",
    "groupMappings": {"admin": ["admin:*"]},
    "defaultScopes": ["read"],
    "createdAt": "2026-03-01T00:00:00Z",
    "updatedAt": "2026-03-01T00:00:00Z",
}

MOCK_SAML_CONNECTION = {
    "id": "sso_conn_02",
    "developerId": "dev_TEST",
    "name": "Okta SAML",
    "protocol": "saml",
    "status": "active",
    "idpEntityId": "https://idp.example.com/saml",
    "idpSsoUrl": "https://idp.example.com/saml/sso",
    "spEntityId": "https://app.grantex.dev",
    "spAcsUrl": "https://app.grantex.dev/sso/callback/saml",
    "domains": ["corp.com"],
    "jitProvisioning": False,
    "enforce": True,
    "groupMappings": {},
    "defaultScopes": [],
    "createdAt": "2026-03-01T00:00:00Z",
    "updatedAt": "2026-03-01T00:00:00Z",
}

MOCK_SESSION = {
    "id": "sso_sess_01",
    "connectionId": "sso_conn_01",
    "principalId": "princ_01",
    "email": "alice@example.com",
    "name": "Alice Smith",
    "idpSubject": "idp_user_01",
    "groups": ["admin"],
    "mappedScopes": ["admin:*"],
    "expiresAt": "2026-03-02T00:00:00Z",
    "createdAt": "2026-03-01T00:00:00Z",
}

MOCK_CALLBACK_RESULT = {
    "sessionId": "sso_sess_01",
    "email": "alice@corp.com",
    "name": "Alice Smith",
    "sub": "idp_user_01",
    "groups": ["engineering"],
    "mappedScopes": ["read", "write"],
    "principalId": "princ_01",
    "developerId": "dev_TEST",
    "expiresAt": "2026-03-02T00:00:00Z",
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


# ── Enterprise SSO Connections ────────────────────────────────────────────


@respx.mock
def test_create_connection(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/sso/connections").mock(
        return_value=httpx.Response(201, json=MOCK_CONNECTION)
    )
    params = CreateSsoConnectionParams(
        name="Okta OIDC",
        protocol="oidc",
        issuer_url="https://idp.example.com",
        client_id="client_abc",
        client_secret="secret_xyz",
        domains=["example.com"],
        jit_provisioning=True,
        group_attribute="groups",
        group_mappings={"admin": ["admin:*"]},
        default_scopes=["read"],
    )
    result = client.sso.create_connection(params)

    assert result.id == "sso_conn_01"
    assert result.name == "Okta OIDC"
    assert result.protocol == "oidc"
    assert result.status == "active"
    assert result.issuer_url == "https://idp.example.com"
    assert result.client_id == "client_abc"
    assert result.domains == ("example.com",)
    assert result.jit_provisioning is True
    assert result.enforce is False
    assert result.group_attribute == "groups"
    assert result.group_mappings == {"admin": ["admin:*"]}
    assert result.default_scopes == ("read",)
    body = route.calls[0].request.read()
    assert b"Okta OIDC" in body
    assert b"secret_xyz" in body


@respx.mock
def test_create_saml_connection(client: Grantex) -> None:
    respx.post(f"{BASE}/v1/sso/connections").mock(
        return_value=httpx.Response(201, json=MOCK_SAML_CONNECTION)
    )
    params = CreateSsoConnectionParams(
        name="Okta SAML",
        protocol="saml",
        idp_entity_id="https://idp.example.com/saml",
        idp_sso_url="https://idp.example.com/saml/sso",
        idp_certificate="MIIC...",
        sp_entity_id="https://app.grantex.dev",
        sp_acs_url="https://app.grantex.dev/sso/callback/saml",
        domains=["corp.com"],
    )
    result = client.sso.create_connection(params)

    assert result.id == "sso_conn_02"
    assert result.protocol == "saml"
    assert result.idp_entity_id == "https://idp.example.com/saml"
    assert result.idp_sso_url == "https://idp.example.com/saml/sso"
    assert result.sp_entity_id == "https://app.grantex.dev"
    assert result.sp_acs_url == "https://app.grantex.dev/sso/callback/saml"


@respx.mock
def test_list_connections(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/sso/connections").mock(
        return_value=httpx.Response(200, json={"connections": [MOCK_CONNECTION, MOCK_SAML_CONNECTION]})
    )
    result = client.sso.list_connections()

    assert len(result.connections) == 2
    assert result.connections[0].id == "sso_conn_01"
    assert result.connections[0].protocol == "oidc"
    assert result.connections[1].id == "sso_conn_02"
    assert result.connections[1].protocol == "saml"


@respx.mock
def test_get_connection(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/sso/connections/sso_conn_01").mock(
        return_value=httpx.Response(200, json=MOCK_CONNECTION)
    )
    result = client.sso.get_connection("sso_conn_01")

    assert result.id == "sso_conn_01"
    assert result.developer_id == "dev_TEST"
    assert result.name == "Okta OIDC"
    assert result.created_at == "2026-03-01T00:00:00Z"


@respx.mock
def test_update_connection(client: Grantex) -> None:
    updated = {**MOCK_CONNECTION, "name": "Okta OIDC v2", "status": "testing"}
    route = respx.patch(f"{BASE}/v1/sso/connections/sso_conn_01").mock(
        return_value=httpx.Response(200, json=updated)
    )
    params = UpdateSsoConnectionParams(name="Okta OIDC v2", status="testing")
    result = client.sso.update_connection("sso_conn_01", params)

    assert result.name == "Okta OIDC v2"
    assert result.status == "testing"
    body = route.calls[0].request.read()
    assert b"Okta OIDC v2" in body


@respx.mock
def test_delete_connection(client: Grantex) -> None:
    route = respx.delete(f"{BASE}/v1/sso/connections/sso_conn_01").mock(
        return_value=httpx.Response(204)
    )
    client.sso.delete_connection("sso_conn_01")

    assert route.called


@respx.mock
def test_test_connection(client: Grantex) -> None:
    respx.post(f"{BASE}/v1/sso/connections/sso_conn_01/test").mock(
        return_value=httpx.Response(200, json={
            "success": True,
            "protocol": "oidc",
            "issuer": "https://idp.example.com",
            "authorizationEndpoint": "https://idp.example.com/authorize",
            "tokenEndpoint": "https://idp.example.com/token",
            "jwksUri": "https://idp.example.com/.well-known/jwks.json",
        })
    )
    result = client.sso.test_connection("sso_conn_01")

    assert result.success is True
    assert result.protocol == "oidc"
    assert result.issuer == "https://idp.example.com"
    assert result.authorization_endpoint == "https://idp.example.com/authorize"
    assert result.token_endpoint == "https://idp.example.com/token"
    assert result.jwks_uri == "https://idp.example.com/.well-known/jwks.json"
    assert result.error is None


@respx.mock
def test_test_connection_failure(client: Grantex) -> None:
    respx.post(f"{BASE}/v1/sso/connections/sso_conn_01/test").mock(
        return_value=httpx.Response(200, json={
            "success": False,
            "protocol": "saml",
            "error": "Invalid IdP certificate",
        })
    )
    result = client.sso.test_connection("sso_conn_01")

    assert result.success is False
    assert result.error == "Invalid IdP certificate"


# ── SSO enforcement ───────────────────────────────────────────────────────


@respx.mock
def test_set_enforcement(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/sso/enforce").mock(
        return_value=httpx.Response(200, json={"enforce": True, "developerId": "dev_TEST"})
    )
    params = SsoEnforcementParams(enforce=True)
    result = client.sso.set_enforcement(params)

    assert result.enforce is True
    assert result.developer_id == "dev_TEST"
    body = route.calls[0].request.read()
    assert b'"enforce"' in body


@respx.mock
def test_set_enforcement_disable(client: Grantex) -> None:
    respx.post(f"{BASE}/v1/sso/enforce").mock(
        return_value=httpx.Response(200, json={"enforce": False, "developerId": "dev_TEST"})
    )
    result = client.sso.set_enforcement(SsoEnforcementParams(enforce=False))

    assert result.enforce is False


# ── SSO sessions ──────────────────────────────────────────────────────────


@respx.mock
def test_list_sessions(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/sso/sessions").mock(
        return_value=httpx.Response(200, json={"sessions": [MOCK_SESSION]})
    )
    result = client.sso.list_sessions()

    assert len(result.sessions) == 1
    s = result.sessions[0]
    assert s.id == "sso_sess_01"
    assert s.connection_id == "sso_conn_01"
    assert s.principal_id == "princ_01"
    assert s.email == "alice@example.com"
    assert s.name == "Alice Smith"
    assert s.idp_subject == "idp_user_01"
    assert s.groups == ("admin",)
    assert s.mapped_scopes == ("admin:*",)
    assert s.expires_at == "2026-03-02T00:00:00Z"
    assert s.created_at == "2026-03-01T00:00:00Z"


@respx.mock
def test_revoke_session(client: Grantex) -> None:
    route = respx.delete(f"{BASE}/v1/sso/sessions/sso_sess_01").mock(
        return_value=httpx.Response(204)
    )
    client.sso.revoke_session("sso_sess_01")

    assert route.called


# ── SSO login flow ────────────────────────────────────────────────────────


@respx.mock
def test_get_login_url(client: Grantex) -> None:
    route = respx.get(f"{BASE}/sso/login").mock(
        return_value=httpx.Response(200, json={
            "authorizeUrl": "https://idp.example.com/authorize?client_id=abc",
            "protocol": "oidc",
            "connectionId": "sso_conn_01",
        })
    )
    result = client.sso.get_login_url("dev_TEST")

    assert "https://idp.example.com/authorize" in result.authorize_url
    assert result.protocol == "oidc"
    assert result.connection_id == "sso_conn_01"
    url = str(route.calls[0].request.url)
    assert "org=dev_TEST" in url


@respx.mock
def test_get_login_url_with_domain(client: Grantex) -> None:
    route = respx.get(f"{BASE}/sso/login").mock(
        return_value=httpx.Response(200, json={
            "authorizeUrl": "https://idp.example.com/authorize?client_id=abc",
            "protocol": "saml",
            "connectionId": "sso_conn_02",
        })
    )
    result = client.sso.get_login_url("dev_TEST", domain="corp.com")

    assert result.protocol == "saml"
    url = str(route.calls[0].request.url)
    assert "org=dev_TEST" in url
    assert "domain=corp.com" in url


@respx.mock
def test_handle_oidc_callback(client: Grantex) -> None:
    route = respx.post(f"{BASE}/sso/callback/oidc").mock(
        return_value=httpx.Response(200, json=MOCK_CALLBACK_RESULT)
    )
    params = SsoOidcCallbackParams(code="auth_code_xyz", state="state_abc")
    result = client.sso.handle_oidc_callback(params)

    assert result.session_id == "sso_sess_01"
    assert result.email == "alice@corp.com"
    assert result.name == "Alice Smith"
    assert result.sub == "idp_user_01"
    assert result.groups == ("engineering",)
    assert result.mapped_scopes == ("read", "write")
    assert result.principal_id == "princ_01"
    assert result.developer_id == "dev_TEST"
    assert result.expires_at == "2026-03-02T00:00:00Z"
    body = route.calls[0].request.read()
    assert b"auth_code_xyz" in body


@respx.mock
def test_handle_oidc_callback_with_redirect_uri(client: Grantex) -> None:
    route = respx.post(f"{BASE}/sso/callback/oidc").mock(
        return_value=httpx.Response(200, json=MOCK_CALLBACK_RESULT)
    )
    params = SsoOidcCallbackParams(
        code="auth_code_xyz",
        state="state_abc",
        redirect_uri="https://app.example.com/callback",
    )
    result = client.sso.handle_oidc_callback(params)

    assert result.session_id == "sso_sess_01"
    body = route.calls[0].request.read()
    assert b"redirect_uri" in body


@respx.mock
def test_handle_saml_callback(client: Grantex) -> None:
    route = respx.post(f"{BASE}/sso/callback/saml").mock(
        return_value=httpx.Response(200, json=MOCK_CALLBACK_RESULT)
    )
    params = SsoSamlCallbackParams(
        saml_response="PHNhbWxwOlJlc3BvbnNl...",
        relay_state="state_abc",
    )
    result = client.sso.handle_saml_callback(params)

    assert result.session_id == "sso_sess_01"
    assert result.developer_id == "dev_TEST"
    body = route.calls[0].request.read()
    assert b"SAMLResponse" in body
    assert b"RelayState" in body


# ── Legacy methods (backward compatible) ──────────────────────────────────


@respx.mock
def test_create_config(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/sso/config").mock(
        return_value=httpx.Response(201, json=MOCK_SSO_CONFIG)
    )
    params = CreateSsoConfigParams(
        issuer_url="https://idp.example.com",
        client_id="client_abc",
        client_secret="secret_xyz",
        redirect_uri="https://app.grantex.dev/sso/callback",
    )
    result = client.sso.create_config(params)

    assert result.issuer_url == "https://idp.example.com"
    assert result.client_id == "client_abc"
    assert result.redirect_uri == "https://app.grantex.dev/sso/callback"
    body = route.calls[0].request.read()
    assert b"client_abc" in body


@respx.mock
def test_get_config(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/sso/config").mock(
        return_value=httpx.Response(200, json=MOCK_SSO_CONFIG)
    )
    result = client.sso.get_config()

    assert result.issuer_url == "https://idp.example.com"
    assert result.created_at == "2026-02-27T00:00:00Z"


@respx.mock
def test_delete_config(client: Grantex) -> None:
    route = respx.delete(f"{BASE}/v1/sso/config").mock(
        return_value=httpx.Response(204)
    )
    client.sso.delete_config()

    assert route.called


@respx.mock
def test_handle_callback(client: Grantex) -> None:
    respx.get(f"{BASE}/sso/callback").mock(
        return_value=httpx.Response(
            200,
            json={
                "email": "alice@corp.com",
                "name": "Alice Smith",
                "sub": "idp_user_01",
                "developerId": "dev_TEST",
            },
        )
    )
    result = client.sso.handle_callback("auth_code_xyz", "state_abc")

    assert result.email == "alice@corp.com"
    assert result.name == "Alice Smith"
    assert result.developer_id == "dev_TEST"


# ── Type serialization ───────────────────────────────────────────────────


def test_create_connection_params_to_dict() -> None:
    params = CreateSsoConnectionParams(
        name="Test",
        protocol="oidc",
        issuer_url="https://idp.example.com",
        client_id="abc",
        client_secret="secret",
    )
    d = params.to_dict()
    assert d["name"] == "Test"
    assert d["protocol"] == "oidc"
    assert d["issuerUrl"] == "https://idp.example.com"
    assert d["clientId"] == "abc"
    assert d["clientSecret"] == "secret"
    assert "idpEntityId" not in d
    assert "domains" not in d


def test_create_connection_params_to_dict_saml() -> None:
    params = CreateSsoConnectionParams(
        name="SAML",
        protocol="saml",
        idp_entity_id="https://idp.example.com/saml",
        idp_sso_url="https://idp.example.com/saml/sso",
        idp_certificate="MIIC...",
        sp_entity_id="https://app.grantex.dev",
        sp_acs_url="https://app.grantex.dev/sso/callback/saml",
        domains=["corp.com"],
        enforce=True,
    )
    d = params.to_dict()
    assert d["protocol"] == "saml"
    assert d["idpEntityId"] == "https://idp.example.com/saml"
    assert d["idpSsoUrl"] == "https://idp.example.com/saml/sso"
    assert d["idpCertificate"] == "MIIC..."
    assert d["spEntityId"] == "https://app.grantex.dev"
    assert d["spAcsUrl"] == "https://app.grantex.dev/sso/callback/saml"
    assert d["domains"] == ["corp.com"]
    assert d["enforce"] is True
    assert "issuerUrl" not in d
    assert "clientId" not in d


def test_update_connection_params_to_dict() -> None:
    params = UpdateSsoConnectionParams(name="Updated", status="inactive")
    d = params.to_dict()
    assert d == {"name": "Updated", "status": "inactive"}


def test_update_connection_params_to_dict_empty() -> None:
    params = UpdateSsoConnectionParams()
    d = params.to_dict()
    assert d == {}


def test_sso_oidc_callback_params_to_dict() -> None:
    params = SsoOidcCallbackParams(code="abc", state="xyz")
    d = params.to_dict()
    assert d == {"code": "abc", "state": "xyz"}
    assert "redirect_uri" not in d


def test_sso_oidc_callback_params_to_dict_with_redirect() -> None:
    params = SsoOidcCallbackParams(code="abc", state="xyz", redirect_uri="https://example.com/cb")
    d = params.to_dict()
    assert d["redirect_uri"] == "https://example.com/cb"


def test_sso_saml_callback_params_to_dict() -> None:
    params = SsoSamlCallbackParams(saml_response="PHNhbWw...", relay_state="state123")
    d = params.to_dict()
    assert d == {"SAMLResponse": "PHNhbWw...", "RelayState": "state123"}


@respx.mock
def test_handle_ldap_callback(client: Grantex) -> None:
    route = respx.post(f"{BASE}/sso/callback/ldap").mock(
        return_value=httpx.Response(200, json=MOCK_CALLBACK_RESULT)
    )
    params = SsoLdapCallbackParams(
        username="carol",
        password="secret",
        connection_id="sso_conn_03",
        org="dev_TEST",
    )
    result = client.sso.handle_ldap_callback(params)

    assert result.session_id == "sso_sess_01"
    assert result.developer_id == "dev_TEST"
    body = route.calls[0].request.read()
    assert b"carol" in body
    assert b"connectionId" in body


@respx.mock
def test_create_ldap_connection(client: Grantex) -> None:
    mock_ldap_connection = {
        **MOCK_CONNECTION,
        "id": "sso_conn_03",
        "name": "Corp LDAP",
        "protocol": "ldap",
        "ldapUrl": "ldap://ldap.corp.com:389",
        "ldapBindDn": "cn=admin,dc=corp,dc=com",
        "ldapSearchBase": "ou=users,dc=corp,dc=com",
        "ldapSearchFilter": "(uid={{username}})",
        "ldapTlsEnabled": True,
    }
    route = respx.post(f"{BASE}/v1/sso/connections").mock(
        return_value=httpx.Response(201, json=mock_ldap_connection)
    )
    params = CreateSsoConnectionParams(
        name="Corp LDAP",
        protocol="ldap",
        ldap_url="ldap://ldap.corp.com:389",
        ldap_bind_dn="cn=admin,dc=corp,dc=com",
        ldap_bind_password="admin_secret",
        ldap_search_base="ou=users,dc=corp,dc=com",
        ldap_search_filter="(uid={{username}})",
        ldap_tls_enabled=True,
        domains=["corp.com"],
    )
    result = client.sso.create_connection(params)

    assert result.id == "sso_conn_03"
    assert result.protocol == "ldap"
    assert result.ldap_url == "ldap://ldap.corp.com:389"
    assert result.ldap_bind_dn == "cn=admin,dc=corp,dc=com"
    assert result.ldap_search_base == "ou=users,dc=corp,dc=com"
    assert result.ldap_search_filter == "(uid={{username}})"
    assert result.ldap_tls_enabled is True
    body = route.calls[0].request.read()
    assert b"ldapUrl" in body
    assert b"ldapBindPassword" in body


def test_sso_ldap_callback_params_to_dict() -> None:
    params = SsoLdapCallbackParams(
        username="carol",
        password="secret",
        connection_id="sso_conn_03",
        org="dev_TEST",
    )
    d = params.to_dict()
    assert d == {
        "username": "carol",
        "password": "secret",
        "connectionId": "sso_conn_03",
        "org": "dev_TEST",
    }


def test_create_connection_params_to_dict_ldap() -> None:
    params = CreateSsoConnectionParams(
        name="LDAP",
        protocol="ldap",
        ldap_url="ldap://ldap.corp.com:389",
        ldap_bind_dn="cn=admin,dc=corp,dc=com",
        ldap_bind_password="admin_secret",
        ldap_search_base="ou=users,dc=corp,dc=com",
        ldap_search_filter="(uid={{username}})",
        ldap_group_search_base="ou=groups,dc=corp,dc=com",
        ldap_group_search_filter="(member={{dn}})",
        ldap_tls_enabled=True,
        domains=["corp.com"],
    )
    d = params.to_dict()
    assert d["protocol"] == "ldap"
    assert d["ldapUrl"] == "ldap://ldap.corp.com:389"
    assert d["ldapBindDn"] == "cn=admin,dc=corp,dc=com"
    assert d["ldapBindPassword"] == "admin_secret"
    assert d["ldapSearchBase"] == "ou=users,dc=corp,dc=com"
    assert d["ldapSearchFilter"] == "(uid={{username}})"
    assert d["ldapGroupSearchBase"] == "ou=groups,dc=corp,dc=com"
    assert d["ldapGroupSearchFilter"] == "(member={{dn}})"
    assert d["ldapTlsEnabled"] is True
    assert d["domains"] == ["corp.com"]
    assert "issuerUrl" not in d
    assert "clientId" not in d
    assert "idpEntityId" not in d


def test_sso_enforcement_params_to_dict() -> None:
    assert SsoEnforcementParams(enforce=True).to_dict() == {"enforce": True}
    assert SsoEnforcementParams(enforce=False).to_dict() == {"enforce": False}
