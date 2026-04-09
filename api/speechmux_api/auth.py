"""Client authentication for the WebSocket proxy.

When ACCESS_TOKEN is set, every WebSocket upgrade request must carry a matching
Bearer token in the Authorization header.  When ACCESS_TOKEN is empty, all
connections are allowed (useful for local development).

Per-user concurrent session limiting is tracked in an in-process counter.
This is sufficient for single-instance deployments; scale-out would require
a distributed counter (Redis).
"""

import logging
from collections import defaultdict
from threading import Lock

from fastapi import WebSocket
from fastapi import status as http_status

from speechmux_api.config import settings

logger = logging.getLogger(__name__)


class SessionLimiter:
    """Tracks concurrent WebSocket sessions per authenticated user.

    Attributes:
        _counts: Map from user identity to active session count.
        _lock: Mutex protecting _counts.
    """

    def __init__(self) -> None:
        self._counts: dict[str, int] = defaultdict(int)
        self._lock = Lock()

    def acquire(self, user_identity: str) -> bool:
        """Attempt to reserve a session slot for the given user.

        Args:
            user_identity: Opaque string identifying the user (e.g. token hash).

        Returns:
            True if the slot was reserved; False if the limit is already reached.
        """
        with self._lock:
            current = self._counts[user_identity]
            if current >= settings.max_sessions_per_user:
                return False
            self._counts[user_identity] = current + 1
            return True

    def release(self, user_identity: str) -> None:
        """Release a previously acquired session slot.

        Args:
            user_identity: The same identity string passed to acquire().
        """
        with self._lock:
            count = self._counts.get(user_identity, 0)
            if count > 1:
                self._counts[user_identity] = count - 1
            else:
                self._counts.pop(user_identity, None)


session_limiter = SessionLimiter()

# Sentinel value used when authentication is disabled.
_ANON_IDENTITY = "__anonymous__"


async def authenticate(websocket: WebSocket) -> str | None:
    """Validate the bearer token on an incoming WebSocket connection.

    If ACCESS_TOKEN is empty, authentication is skipped and a shared anonymous
    identity is returned.

    Args:
        websocket: The incoming WebSocket connection (not yet accepted).

    Returns:
        The user identity string on success, or None on authentication failure.
        On failure the WebSocket is closed with 4001 before returning.
    """
    if not settings.access_token:
        return _ANON_IDENTITY

    authorization = websocket.headers.get("Authorization", "")
    if not authorization.startswith("Bearer "):
        # Browser WebSocket API cannot set custom headers; fall back to the
        # ?token= query parameter that speechmux-ws.ts sends when a token is set.
        query_token = websocket.query_params.get("token", "")
        if query_token:
            authorization = f"Bearer {query_token}"
    if not authorization.startswith("Bearer "):
        logger.warning("WebSocket rejected: missing or malformed Authorization header")
        await websocket.close(code=http_status.WS_1008_POLICY_VIOLATION)
        return None

    token = authorization.removeprefix("Bearer ")
    if token != settings.access_token:
        logger.warning("WebSocket rejected: invalid access token")
        await websocket.close(code=http_status.WS_1008_POLICY_VIOLATION)
        return None

    return token


async def check_session_limit(websocket: WebSocket, user_identity: str) -> bool:
    """Check and reserve a session slot for the user.

    Args:
        websocket: The incoming WebSocket connection (not yet accepted).
        user_identity: Identity returned by authenticate().

    Returns:
        True if the slot was reserved; False if the limit is exceeded (the
        WebSocket is closed with 4029 before returning False).
    """
    if not session_limiter.acquire(user_identity):
        logger.warning(
            "WebSocket rejected: session limit reached for user %s", user_identity
        )
        await websocket.close(code=4029)
        return False
    return True
