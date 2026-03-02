"""Google A2A protocol bridge for Grantex."""

from ._client import A2AGrantexClient
from ._server import create_a2a_auth_middleware, A2AAuthError
from ._agent_card import build_grantex_agent_card
from ._jwt import decode_jwt_payload, is_token_expired
from ._types import (
    A2ATask,
    A2ATaskStatus,
    A2AMessage,
    A2APart,
    A2AArtifact,
    TaskSendParams,
    TaskGetParams,
    TaskCancelParams,
    VerifiedGrant,
    A2AAgentCard,
    GrantexAuthConfig,
    GrantexAgentCardOptions,
    A2AAuthMiddlewareOptions,
    A2AGrantexClientOptions,
)

__all__ = [
    "A2AGrantexClient",
    "create_a2a_auth_middleware",
    "A2AAuthError",
    "build_grantex_agent_card",
    "decode_jwt_payload",
    "is_token_expired",
    "A2ATask",
    "A2ATaskStatus",
    "A2AMessage",
    "A2APart",
    "A2AArtifact",
    "TaskSendParams",
    "TaskGetParams",
    "TaskCancelParams",
    "VerifiedGrant",
    "A2AAgentCard",
    "GrantexAuthConfig",
    "GrantexAgentCardOptions",
    "A2AAuthMiddlewareOptions",
    "A2AGrantexClientOptions",
]
