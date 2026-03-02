from __future__ import annotations

from typing import Any, Dict, List, Optional

from .._http import HttpClient


class CreateDomainParams:
    def __init__(self, domain: str) -> None:
        self.domain = domain

    def to_dict(self) -> Dict[str, Any]:
        return {"domain": self.domain}


class DomainEntry:
    def __init__(
        self,
        id: str,
        domain: str,
        verified: bool,
        verified_at: Optional[str],
        created_at: str,
    ) -> None:
        self.id = id
        self.domain = domain
        self.verified = verified
        self.verified_at = verified_at
        self.created_at = created_at

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DomainEntry":
        return cls(
            id=data["id"],
            domain=data["domain"],
            verified=data["verified"],
            verified_at=data.get("verifiedAt"),
            created_at=data["createdAt"],
        )


class CreateDomainResponse:
    def __init__(
        self,
        id: str,
        domain: str,
        verified: bool,
        verification_token: str,
        instructions: str,
    ) -> None:
        self.id = id
        self.domain = domain
        self.verified = verified
        self.verification_token = verification_token
        self.instructions = instructions

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CreateDomainResponse":
        return cls(
            id=data["id"],
            domain=data["domain"],
            verified=data["verified"],
            verification_token=data["verificationToken"],
            instructions=data["instructions"],
        )


class ListDomainsResponse:
    def __init__(self, domains: List[DomainEntry]) -> None:
        self.domains = domains

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ListDomainsResponse":
        return cls(domains=[DomainEntry.from_dict(d) for d in data["domains"]])


class VerifyDomainResponse:
    def __init__(self, verified: bool, message: str) -> None:
        self.verified = verified
        self.message = message

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "VerifyDomainResponse":
        return cls(verified=data["verified"], message=data["message"])


class DomainsClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, params: CreateDomainParams) -> CreateDomainResponse:
        """Register a custom domain. Enterprise plan required."""
        data = self._http.post("/v1/domains", params.to_dict())
        return CreateDomainResponse.from_dict(data)

    def list(self) -> ListDomainsResponse:
        """List custom domains."""
        data = self._http.get("/v1/domains")
        return ListDomainsResponse.from_dict(data)

    def verify(self, domain_id: str) -> VerifyDomainResponse:
        """Verify a custom domain via DNS."""
        data = self._http.post(f"/v1/domains/{domain_id}/verify")
        return VerifyDomainResponse.from_dict(data)

    def delete(self, domain_id: str) -> None:
        """Delete a custom domain."""
        self._http.delete(f"/v1/domains/{domain_id}")
