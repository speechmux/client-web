"""WebSocket proxy: relays browser ↔ SpeechMux Core bidirectionally.

Protocol:
    1. Browser connects to this proxy at /ws/stream.
    2. Proxy connects upstream to Core at CORE_WS_URL.
    3. Browser sends {"type":"start", ...} as the first text frame.
       Proxy injects core_api_key into that message before forwarding.
    4. All subsequent text frames (control, results) and binary frames
       (PCM audio) are relayed zero-copy in both directions.
    5. When either side closes, the other is closed as well.
"""

import asyncio
import json
import logging

import websockets
import websockets.exceptions
from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.client import ClientConnection

from speechmux_api.config import settings

logger = logging.getLogger(__name__)


async def _inject_api_key(raw_message: str) -> str:
    """Inject the configured Core API key into a start message.

    Args:
        raw_message: The raw JSON text of the first browser frame.

    Returns:
        The (possibly modified) JSON string to forward to Core.
    """
    if not settings.core_api_key:
        return raw_message
    try:
        payload: dict[str, object] = json.loads(raw_message)
        if payload.get("type") == "start":
            payload["api_key"] = settings.core_api_key
            return json.dumps(payload)
    except (json.JSONDecodeError, TypeError):
        pass
    return raw_message


async def _relay_browser_to_core(
    browser_ws: WebSocket,
    core_ws: ClientConnection,
    first_message_done: asyncio.Event,
) -> None:
    """Forward messages from the browser to Core.

    The first text message has the Core API key injected before forwarding.
    Uses raw receive() to handle both text and binary frames correctly;
    iter_bytes() / iter_text() only handle one frame type each.

    Args:
        browser_ws: The browser-side WebSocket (Starlette).
        core_ws: The upstream Core WebSocket (websockets library).
        first_message_done: Event set after the first message is forwarded.

    Raises:
        WebSocketDisconnect: When the browser closes the connection.
        websockets.exceptions.ConnectionClosed: When Core closes the connection.
    """
    first = True
    while True:
        raw = await browser_ws.receive()
        if raw["type"] == "websocket.disconnect":
            break

        # Per ASGI spec, Starlette always includes both "text" and "bytes" keys
        # in the receive dict. For binary frames raw["text"] is None (not absent),
        # and for text frames raw["bytes"] is None. Use .get() with falsy check to
        # distinguish them — otherwise `core_ws.send(None)` raises TypeError.
        text: str | None = raw.get("text") or None
        data: bytes | None = raw.get("bytes") or None

        if text is None and data is None:
            continue  # empty frame — skip

        if first:
            first = False
            first_message_done.set()
            if text is not None:
                text = await _inject_api_key(text)

        if text is not None:
            await core_ws.send(text)
        elif data is not None:
            await core_ws.send(data)


async def _relay_core_to_browser(
    core_ws: ClientConnection,
    browser_ws: WebSocket,
) -> None:
    """Forward messages from Core to the browser.

    Args:
        core_ws: The upstream Core WebSocket (websockets library).
        browser_ws: The browser-side WebSocket (Starlette).

    Raises:
        websockets.exceptions.ConnectionClosed: When Core closes the connection.
    """
    async for message in core_ws:
        if isinstance(message, str):
            # Debug: log result messages to diagnose is_final delivery
            if '"type":"result"' in message or '"type": "result"' in message:
                try:
                    payload = json.loads(message)
                    logger.info(
                        "RELAY result is_final=%s committed=%r unstable=%r",
                        payload.get("is_final"),
                        payload.get("committed_text", "")[:60],
                        payload.get("unstable_text", "")[:60],
                    )
                except Exception:
                    pass
            await browser_ws.send_text(message)
        else:
            await browser_ws.send_bytes(message)


async def _heartbeat(core_ws: ClientConnection, interval_sec: float = 30.0) -> None:
    """Send periodic pings to Core to detect dead connections.

    Returns when Core fails to respond to a ping or closes the connection.
    The calling task should treat a normal return as a signal that Core is down.

    Args:
        core_ws: The upstream Core WebSocket connection.
        interval_sec: How often to send a ping (default: 30 seconds).
    """
    while True:
        await asyncio.sleep(interval_sec)
        try:
            await core_ws.ping()
        except Exception:
            # Core connection lost — return so proxy_session can cancel relay tasks.
            return


async def proxy_session(browser_ws: WebSocket) -> None:
    """Handle one browser WebSocket session end-to-end.

    Connects upstream to Core, relays traffic bidirectionally, and ensures
    both sides are cleaned up when either side closes.

    Args:
        browser_ws: The accepted browser WebSocket connection.
    """
    await browser_ws.accept()
    logger.info("Browser connected; opening upstream Core connection to %s", settings.core_ws_url)

    try:
        async with websockets.connect(settings.core_ws_url) as core_ws:
            first_message_done: asyncio.Event = asyncio.Event()

            browser_to_core_task = asyncio.create_task(
                _relay_browser_to_core(browser_ws, core_ws, first_message_done)
            )
            core_to_browser_task = asyncio.create_task(
                _relay_core_to_browser(core_ws, browser_ws)
            )
            heartbeat_task = asyncio.create_task(_heartbeat(core_ws))

            done, pending = await asyncio.wait(
                {browser_to_core_task, core_to_browser_task, heartbeat_task},
                return_when=asyncio.FIRST_COMPLETED,
            )

            for task in pending:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

            # Notify the browser about unexpected terminations.
            for task in done:
                exception = task.exception()
                if task is heartbeat_task and exception is None:
                    # Heartbeat detected that Core is unresponsive.
                    logger.warning("Heartbeat: Core connection lost; notifying browser")
                    try:
                        await browser_ws.send_text(json.dumps(
                            {"type": "error", "code": "PROXY_UPSTREAM_DOWN",
                             "message": "Connection to server lost."}
                        ))
                    except Exception:
                        pass
                elif exception and not isinstance(
                    exception, (WebSocketDisconnect, websockets.exceptions.ConnectionClosed)
                ):
                    logger.warning("Relay task ended with error: %s", exception)
                    try:
                        error_payload = json.dumps(
                            {"type": "error", "code": "PROXY_RELAY_ERROR", "message": "relay error"}
                        )
                        await browser_ws.send_text(error_payload)
                    except Exception:
                        pass

    except websockets.exceptions.ConnectionClosed as connection_error:
        logger.info("Core connection closed: %s", connection_error)
    except OSError as os_error:
        logger.error("Failed to connect to Core at %s: %s", settings.core_ws_url, os_error)
        try:
            error_payload = json.dumps(
                {"type": "error", "code": "PROXY_UPSTREAM_DOWN", "message": str(os_error)}
            )
            await browser_ws.send_text(error_payload)
        except Exception:
            pass
    finally:
        try:
            await browser_ws.close()
        except Exception:
            pass
        logger.info("Proxy session ended")
