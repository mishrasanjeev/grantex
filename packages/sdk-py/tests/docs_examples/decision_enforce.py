from typing import Any, Dict, List

from grantex import Grantex


def call_case_decision(
    grantex: Grantex,
    grant_token: str,
    decision_grants: List[str],
    tool_call_arguments: Dict[str, Any],
    current_case_version: str,
) -> None:
    """Calls a tool that needs a decision, with the decision grants a person approved."""
    result = grantex.enforce(
        grant_token,
        "acme_kyb",
        "case_decision",
        decision_grants=decision_grants,  # two for a decision listed in four_eyes_on
        arguments=tool_call_arguments,  # the approved action is derived from these
        case_version=current_case_version,  # from your own case state, never from the agent
    )
    if not result.allowed:
        # reason_code is decision_required or decision_invalid; sub_reason says why
        raise PermissionError(f"{result.reason_code}/{result.sub_reason}: {result.reason}")
    # The grants are now spent: result.decision.jtis
