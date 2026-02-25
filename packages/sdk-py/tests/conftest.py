"""Shared fixtures and mock data for the Grantex Python SDK test suite."""
from __future__ import annotations

import pytest

# ─── Mock response data (camelCase, matching the API JSON format) ─────────────

MOCK_AGENT: dict = {
    "id": "ag_01HXYZ123abc",
    "did": "did:grantex:ag_01HXYZ123abc",
    "name": "travel-booker",
    "description": "Books flights and hotels",
    "scopes": ["calendar:read", "payments:initiate:max_500"],
    "status": "active",
    "developerId": "org_test",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z",
}

MOCK_GRANT: dict = {
    "id": "grant_01HXYZ",
    "agentId": "ag_01HXYZ123abc",
    "agentDid": "did:grantex:ag_01HXYZ123abc",
    "principalId": "user_abc123",
    "developerId": "org_test",
    "scopes": ["calendar:read", "payments:initiate:max_500"],
    "status": "active",
    "issuedAt": "2024-01-01T00:00:00Z",
    "expiresAt": "2024-01-02T00:00:00Z",
}

MOCK_AUDIT_ENTRY: dict = {
    "id": "audit_01HXYZ",
    "agentId": "ag_01HXYZ123abc",
    "agentDid": "did:grantex:ag_01HXYZ123abc",
    "grantId": "grant_01HXYZ",
    "principalId": "user_abc123",
    "action": "payment.initiated",
    "metadata": {"amount": 420, "currency": "USD"},
    "hash": "abc123hash",
    "previousHash": None,
    "timestamp": "2024-01-01T00:01:00Z",
}

MOCK_JWT_PAYLOAD: dict = {
    "iss": "https://grantex.dev",
    "sub": "user_abc123",
    "agt": "did:grantex:ag_01HXYZ123abc",
    "dev": "org_test",
    "scp": ["calendar:read", "payments:initiate:max_500"],
    "iat": 1709000000,
    "exp": 9999999999,
    "jti": "tok_01HXYZ987xyz",
    "gid": "grant_01HXYZ",
}

MOCK_AUTHORIZATION_REQUEST: dict = {
    "requestId": "req_01HXYZ",
    "consentUrl": "https://consent.grantex.dev/authorize?req=eyJ",
    "agentId": "ag_01HXYZ123abc",
    "principalId": "user_abc123",
    "scopes": ["calendar:read"],
    "expiresIn": "24h",
    "expiresAt": "2024-01-02T00:00:00Z",
    "status": "pending",
    "createdAt": "2024-01-01T00:00:00Z",
}
