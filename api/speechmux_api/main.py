"""FastAPI application entry point for the SpeechMux proxy backend."""

import logging

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from speechmux_api.auth import authenticate, check_session_limit, session_limiter
from speechmux_api.config import settings
from speechmux_api.ws_proxy import proxy_session

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="SpeechMux Proxy API",
    description="WebSocket proxy and authentication layer for SpeechMux Core.",
    version="0.1.0",
)

_origins = settings.cors_origins_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    # credentials=True is incompatible with allow_origins=["*"].
    allow_credentials="*" not in _origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Return proxy liveness status."""
    return {"status": "ok"}


@app.websocket("/ws/stream")
async def websocket_stream(websocket: WebSocket) -> None:
    """Accept a browser WebSocket and proxy it to SpeechMux Core.

    Auth flow:
        1. Validate WebSocket Origin header against CORS allowed list.
        2. Validate bearer token (if ACCESS_TOKEN is configured).
        3. Enforce per-user session limit.
        4. Delegate to proxy_session() for bidirectional relay.

    Args:
        websocket: The incoming browser WebSocket connection.
    """
    # WebSocket connections bypass HTTP CORS enforcement, so we validate the
    # Origin header explicitly. Non-browser clients (curl, CLI) send no Origin
    # and are always allowed. Only reject browser requests from unknown origins.
    origin = websocket.headers.get("origin") or ""
    allowed_origins = settings.cors_origins_list
    if origin and allowed_origins and "*" not in allowed_origins and origin not in allowed_origins:
        logger.warning("Rejected WebSocket from disallowed origin: %s", origin)
        await websocket.accept()
        await websocket.close(code=4001)
        return

    user_identity = await authenticate(websocket)
    if user_identity is None:
        return

    if not await check_session_limit(websocket, user_identity):
        return

    logger.info("Starting proxy session for user %s", user_identity)
    try:
        await proxy_session(websocket)
    finally:
        session_limiter.release(user_identity)
        logger.info("Session released for user %s", user_identity)
