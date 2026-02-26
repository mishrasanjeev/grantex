from __future__ import annotations

import types
from typing import Any


def with_audit_logging(
    tool: Any,
    client: Any,
    *,
    agent_id: str,
    grant_id: str,
) -> Any:
    """Wrap a CrewAI tool's ``_run`` method with Grantex audit logging.

    On success, logs a ``'tool.run'`` audit entry with ``status='success'``.
    On failure, logs with ``status='failure'`` and re-raises the exception.

    Args:
        tool: A CrewAI ``BaseTool`` instance (returned by
              :func:`create_grantex_tool`).
        client: A ``grantex.Grantex`` client instance.
        agent_id: The Grantex agent ID to attribute the action to.
        grant_id: The grant ID authorising this tool invocation.

    Returns:
        The same ``tool`` object with its ``_run`` method patched in-place.

    Example::

        tool = with_audit_logging(tool, grantex_client,
                                  agent_id="ag_01...", grant_id="grnt_01...")
    """
    original_run = tool._run  # noqa: SLF001

    def _audited_run(**kwargs: Any) -> str:
        action = f"tool.run:{tool.name}"
        try:
            result: str = original_run(**kwargs)
            client.audit.log(
                agent_id=agent_id,
                grant_id=grant_id,
                action=action,
                metadata={"kwargs": kwargs},
                status="success",
            )
            return result
        except Exception as exc:
            client.audit.log(
                agent_id=agent_id,
                grant_id=grant_id,
                action=action,
                metadata={"kwargs": kwargs, "error": str(exc)},
                status="failure",
            )
            raise

    # Replace the bound method via types.MethodType so self is passed correctly
    tool._run = types.MethodType(  # noqa: SLF001
        lambda self, **kw: _audited_run(**kw), tool
    )
    return tool
