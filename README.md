# speechmux/client-web

Web client for SpeechMux. A Next.js 15 frontend captures microphone audio and displays live transcriptions. A FastAPI backend proxies WebSocket connections between the browser and Core.

## Architecture

```
Browser (Next.js 15)
    │
    │  AudioWorklet (mic PCM)
    │  WebSocket (JSON frames)
    ▼
FastAPI Backend
    │
    │  WebSocket relay
    ▼
SpeechMux Core (:8091)
```

## Structure

```
client-web/
├── web/                          # Next.js 15 frontend
│   ├── app/
│   │   ├── layout.tsx            # Root layout + theme init
│   │   └── page.tsx              # Main UI: hero, status grid, controls, transcript
│   ├── components/
│   │   ├── TranscriptView.tsx    # Transcript rendering (committed + unstable)
│   │   ├── AudioCapture.tsx      # AudioWorklet-based microphone input
│   │   ├── BatchPanel.tsx        # File batch upload UI
│   │   └── StatusBar.tsx         # Connection/session status indicators
│   ├── lib/
│   │   ├── speechmux-ws.ts       # WebSocket client with Silent Reconnect
│   │   └── audio-utils.ts        # PCM conversion and resampling utilities
│   ├── public/
│   │   └── pcm-processor.js      # AudioWorklet processor (Float32 → PCM S16LE)
│   ├── app/globals.css           # CSS variables + responsive layout
│   ├── package.json
│   ├── tsconfig.json             # TypeScript strict mode
│   └── next.config.ts
│
└── api/                          # FastAPI backend
    ├── speechmux_api/
    │   ├── main.py               # FastAPI app + route registration
    │   ├── ws_proxy.py           # WebSocket relay (browser ↔ Core)
    │   ├── auth.py               # Bearer token auth + per-user session limiting
    │   └── config.py             # Pydantic settings
    └── pyproject.toml
```

## Prerequisites

- Node.js 22+
- Python 3.13+
- [uv](https://docs.astral.sh/uv/) package manager
- SpeechMux Core running with WebSocket enabled (`ws_port: 8091`)

## Install

### Frontend

```bash
cd web
npm install
```

### Backend

```bash
cd api
uv sync --extra dev
```

## Run

### Development

```bash
# Terminal 1: FastAPI backend
cd api
uv run uvicorn speechmux_api.main:app --reload --port 8000

# Terminal 2: Next.js frontend
cd web
npm run dev
```

Open `http://localhost:3000` in a browser.

### HTTPS (Caddy — required for microphone on non-localhost origins)

Browsers require a secure context (HTTPS) for `getUserMedia`. Caddy provides a
local HTTPS proxy with an auto-trusted CA certificate.

```bash
# One-time: install Caddy local CA into system/browser trust stores
caddy trust

# Terminal 1: FastAPI backend
cd api && uv run uvicorn speechmux_api.main:app --port 8000

# Terminal 2: Next.js frontend (must match WEB_NEXT_PORT in Caddyfile, default 3020)
cd web && npm run dev -- --port 3020

# Terminal 3: Caddy reverse proxy
caddy run --config Caddyfile
```

Open `https://localhost:8443` in a browser (default `CADDY_PORT`).

For plain HTTP behind an upstream TLS terminator (e.g. Tailscale), use
`Caddyfile.proxy` instead. Environment variables `CADDY_PORT`,
`CADDY_NOTLS_PORT`, `WEB_API_PORT`, and `WEB_NEXT_PORT` override the
defaults in both Caddyfiles.

### Production

```bash
# Build frontend
cd web && npm run build

# Serve with Next.js
npm start

# Run API server
cd api
uv run uvicorn speechmux_api.main:app --host 0.0.0.0 --port 8000
```

## Features

### Real-Time Microphone Transcription

1. Click "Start" to begin microphone capture (requires HTTPS or localhost)
2. Audio is captured via `AudioWorklet` at 16 kHz PCM S16LE
3. Chunks are sent over WebSocket to the FastAPI proxy, which relays to Core
4. Partial (unstable) text updates in real time; final (committed) text is appended on utterance end
5. Mic mode includes an inactivity watchdog that auto-stops the session if no
   audio frames arrive from the browser for 5 minutes

### Silent Reconnect

The WebSocket client (`speechmux-ws.ts`) implements automatic reconnection:

- On unexpected disconnect, reconnects with exponential backoff + jitter
- `reconnect_delay = min(500ms × 2^attempt, 10000ms) + random(0, 1000ms)`
- Committed text is preserved across reconnects
- Re-entrance guard prevents concurrent connection attempts
- Status indicator shows connection state: `idle` / `connecting` / `ready` / `reconnecting` / `error` / `done`

### Batch File Upload

The `BatchPanel` component supports drag-and-drop file uploads for batch transcription.

### Status Display

Color-coded status indicators show:
- WebSocket connection state
- Audio capture state
- Transfer (upload) state
- Recognition result state

## WebSocket Protocol

The browser communicates with Core via JSON WebSocket messages proxied through
the FastAPI backend.

**Start a session (first text frame):**
```json
{
  "type": "start",
  "session_id": "web-<timestamp>",
  "sample_rate": 16000,
  "task": "transcribe",
  "language_code": "ko",
  "decode_profile": "realtime",
  "vad_silence": 0.8,
  "vad_threshold": 0.65
}
```

**Server confirms:**
```json
{"type": "session"}
```

**Send audio (binary frames):**
Raw PCM S16LE bytes sent as WebSocket binary messages.

**Receive results:**
```json
{
  "type": "result",
  "is_final": true,
  "text": "...",
  "committed_text": "...",
  "unstable_text": "...",
  "language_code": "ko",
  "start_sec": 0.0,
  "end_sec": 1.5
}
```

**Signal end-of-audio:**
```json
{"type": "end"}
```

**Server signals session complete:**
```json
{"type": "done"}
```

**Server error:**
```json
{"type": "error", "code": "ERR3004", "message": "..."}
```

## Test

```bash
# Frontend
cd web && npm run lint

# Backend
cd api && uv run pytest tests/ -v
```

## License

MIT
