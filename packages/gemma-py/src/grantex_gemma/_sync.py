"""Audit sync to cloud — re-exported types live here for clarity."""

from __future__ import annotations

# SyncResult is defined in _types.py and used by OfflineAuditLog.sync().
# This module exists for organizational symmetry; the sync logic is
# co-located with OfflineAuditLog in _audit_log.py because it needs
# direct access to the log file entries.

from ._types import SyncResult

__all__ = ["SyncResult"]
