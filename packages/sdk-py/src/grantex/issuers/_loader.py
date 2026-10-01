"""Find and build the configured accredited issuer adapter.

Adapters register under the ``grantex.issuers`` entry point group; the name in
``GRANTEX_ISSUER_ADAPTER`` selects one. The SDK itself registers ``mock``. A
name that is not installed fails closed with ``adapter_not_installed``; nothing
falls back to the mock on its own.
"""

from __future__ import annotations

import importlib.metadata as importlib_metadata
from typing import Any, Callable, List, Mapping, Optional

from ._errors import (
    ADAPTER_AMBIGUOUS,
    ADAPTER_INVALID,
    ADAPTER_NOT_CONFIGURED,
    ADAPTER_NOT_INSTALLED,
    IssuerAdapterError,
)
from ._protocol import AccreditedIssuerClient
from ._types import IssuerAdapterConfig

ENTRY_POINT_GROUP = "grantex.issuers"
ADAPTER_ENV = "GRANTEX_ISSUER_ADAPTER"
MOCK_ADAPTER_NAME = "mock"

#: An entry point names a factory: ``factory(config) -> AccreditedIssuerClient``.
AdapterFactory = Callable[[IssuerAdapterConfig], AccreditedIssuerClient]


def _entry_points(group: str) -> List[importlib_metadata.EntryPoint]:
    # Python 3.9 returns a dict keyed by group; 3.10+ a selectable collection.
    found = importlib_metadata.entry_points()
    select = getattr(found, "select", None)
    if select is not None:
        return list(select(group=group))
    groups: Any = found
    return list(groups.get(group, []))


def installed_adapters() -> List[str]:
    """The adapter names installed in this environment, sorted."""
    return sorted({ep.name for ep in _entry_points(ENTRY_POINT_GROUP)})


def load_issuer_client(
    name: Optional[str] = None,
    *,
    config: Optional[IssuerAdapterConfig] = None,
    environ: Optional[Mapping[str, str]] = None,
) -> AccreditedIssuerClient:
    """Build the adapter ``name`` (default: ``GRANTEX_ISSUER_ADAPTER``).

    Raises :class:`IssuerAdapterError` with ``adapter_not_configured`` when no
    name is given anywhere, ``adapter_not_installed`` when no entry point has
    that name, ``adapter_ambiguous`` when more than one does, and
    ``adapter_invalid`` when the entry point does not build an
    :class:`AccreditedIssuerClient`.
    """
    resolved = config if config is not None else IssuerAdapterConfig.from_environ(environ)
    adapter = name or resolved.adapter
    if not adapter:
        raise IssuerAdapterError(
            ADAPTER_NOT_CONFIGURED,
            f"no accredited issuer adapter is configured; set {ADAPTER_ENV} "
            f"({MOCK_ADAPTER_NAME!r} for the mock issuer) or pass a name",
        )
    matches = [ep for ep in _entry_points(ENTRY_POINT_GROUP) if ep.name == adapter]
    if not matches:
        installed = ", ".join(installed_adapters()) or "none"
        raise IssuerAdapterError(
            ADAPTER_NOT_INSTALLED,
            f"no accredited issuer adapter named {adapter!r} is installed "
            f"(installed: {installed}); install the package that provides the "
            f"{ENTRY_POINT_GROUP!r} entry point {adapter!r}, or set "
            f"{ADAPTER_ENV}={MOCK_ADAPTER_NAME}",
        )
    if len(matches) > 1:
        # EntryPoint.dist exists from Python 3.10; the name is a courtesy in the message.
        dists = [getattr(ep, "dist", None) for ep in matches]
        origins = ", ".join(sorted({(dist.name if dist is not None else "?") for dist in dists}))
        raise IssuerAdapterError(
            ADAPTER_AMBIGUOUS,
            f"{len(matches)} packages provide the adapter {adapter!r} ({origins}); uninstall all but one",
        )
    entry_point = matches[0]
    try:
        factory: Any = entry_point.load()
    except Exception as exc:  # the entry point names something that does not import
        raise IssuerAdapterError(
            ADAPTER_INVALID, f"adapter {adapter!r} ({entry_point.value}) does not import: {exc}"
        ) from exc
    if not callable(factory):
        raise IssuerAdapterError(ADAPTER_INVALID, f"adapter {adapter!r} ({entry_point.value}) is not callable")
    client = factory(resolved)
    if not isinstance(client, AccreditedIssuerClient):
        raise IssuerAdapterError(
            ADAPTER_INVALID,
            f"adapter {adapter!r} ({entry_point.value}) did not return an AccreditedIssuerClient "
            "(issuer_metadata, request_attestation, fetch_status)",
        )
    return client
