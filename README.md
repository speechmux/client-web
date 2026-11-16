# speechmux/client-web

Web client for SpeechMux. A Next.js 15 frontend captures microphone audio or uploaded files and displays live transcriptions. A FastAPI backend proxies WebSocket connections between the browser and Core.

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
│   │   ├── layout.tsx            # Root layout + pre-paint theme init
│   │   ├── page.tsx              # Session state and page layout
│   │   ├── globals.css           # Design tokens (dark/light) + all component styles
│   │   ├── icon.svg              # Favicon
│   │   └── api/engines/route.ts  # Engine list from Core's /admin/plugins
│   ├── components/
│   │   ├── AudioCapture.tsx      # Microphone (AudioWorklet) and file audio source
│   │   ├── SetupPanel.tsx        # Mode switch, settings form, folded summary
│   │   ├── TranscriptView.tsx    # Transcript lines, auto-follow, empty states
│   │   ├── StatusStrip.tsx       # Connection / Capture / Transfer / Result states
│   │   ├── SessionDock.tsx       # Start/Stop button, clock, mic level, upload progress
│   │   ├── BatchPanel.tsx        # Batch upload: drop zone, per-file progress, export
│   │   ├── LogsPanel.tsx         # Collapsible client log
│   │   ├── ThemeToggle.tsx       # System / light / dark switch
│   │   └── CopyButton.tsx        # Copy with in-place "Copied" confirmation
│   ├── lib/
│   │   ├── speechmux-ws.ts       # WebSocket client with Silent Reconnect
│   │   ├── transcript.ts         # Folding recognition results into transcript lines
│   │   ├── settings.ts           # Settings saved in localStorage (validated on load)
│   │   ├── srt.ts                # SRT formatting (matches client-cli)
│   │   ├── engine-options.ts     # /api/engines response shape + fallback list
│   │   ├── format.ts             # Clock, duration and size formatters
│   │   ├── browser.ts            # Clipboard and file-download helpers
│   │   ├── audio-utils.ts        # PCM conversion and resampling utilities
│   │   └── *.test.ts             # Vitest unit tests for the modules above
│   ├── public/
│   │   └── pcm-processor.js      # AudioWorklet processor (Float32 → PCM S16LE)
│   ├── vitest.config.mts
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

The page has three input modes, switched at the top of the setup card: **Microphone**,
**Audio file** and **Batch**. Mode, language, engine, VAD settings and pacing are saved in
`localStorage` and restored on the next visit. The theme switch (system / light / dark) is
in the header.

### Live sessions (Microphone, Audio file)

1. Press **Start** (or Space) to capture the microphone, or choose a file and press
   **Send file**. The microphone needs HTTPS or localhost; elsewhere the page says so and
   disables Start instead of failing after the click.
2. Audio is sent as 16 kHz PCM S16LE over WebSocket to the FastAPI proxy, which relays to
   Core. A file goes out in 80 ms frames, paced at 1× speed unless **Realtime pacing** is
   off.
3. Partial (unstable) text updates in place and is marked *Live*; final text is appended
   per utterance. The transcript follows the newest line while you are at the bottom and
   shows **Jump to latest** once you scroll up.
4. While a session runs the setup card folds into a one-line summary and the bottom dock
   shows the elapsed time with the mic level or the upload progress. The button becomes
   **Stop**; after Stop it reads **Finishing…** until the server's last results arrive.
5. When the server reports the session done, a summary line gives the utterance count, the
   audio length and the engine — or says that no speech was recognised.
6. Mic mode includes an inactivity watchdog that auto-stops the session if no
   audio frames arrive from the browser for 5 minutes.

The transcript can be copied or downloaded as `.txt`. **Advanced** holds the VAD threshold
and silence, the decode profile and the WebSocket URL. The decode profile is sent as
`decode_profile`, but Core does not apply it to decoding yet (see the workspace's
`docs/plans/decode-options-and-task-passthrough.md`), and the page says so.

### Status strip

Four states — Connection, Capture, Transfer, Result — each shown as an icon plus a word,
so a state is readable without relying on colour. The collapsible **Logs** card below the
transcript lists connection and session events and flags warnings and errors in its header.

### Silent Reconnect

The WebSocket client (`speechmux-ws.ts`) reconnects on an unexpected close or `ERR3004`:

- Up to 3 attempts with exponential backoff + jitter:
  `reconnect_delay = min(500ms × 2^attempt, 10000ms) + random(0, 1000ms)`
- The last 2 s of audio are kept and replayed after reconnecting, in 80 ms frames (Core
  closes the connection on any WebSocket message above 32 768 bytes).
- The attempt counter resets only after the reconnected session has stayed up for 5 s, so
  a connection that keeps dropping ends in an error instead of retrying forever.
- The page shows the attempt number (`Reconnecting 2/3`) and a banner while this happens,
  and keeps the line that was in progress when the connection dropped.
- If the connection closes after Stop without the server's `done`, the session is
  finished rather than left waiting.

### Batch File Upload

`BatchPanel` transcribes several files in parallel sessions (1, 2, 4 or 8). Drop files or
browse, press **Start**, and each file shows its progress and transcript. Failed files can
be retried; **Cancel** stops files that are still sending or waiting. Finished transcripts
export as **JSON** (with per-segment timestamps) or **TXT** for the whole batch, and as an
**SRT** file per input file — the same layout `speechmux batch --srt` writes.

### Engine list

`/api/engines` asks Core's `/admin/plugins` for healthy inference endpoints (the answer is
cached for 30 s) and returns `{ "engines": [...], "source": "core" | "unreachable" |
"no_healthy_engines" }`. When the list is not Core's own, the page shows the built-in
fallback list together with a note saying so.

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
  "vad_threshold": 0.5,
  "engine_hint": ""
}
```

**Server confirms:**
```json
{"type": "session"}
```

**Send audio (binary frames):**
Raw PCM S16LE bytes sent as WebSocket binary messages. Keep each message at or below
32 768 bytes — Core closes the connection on a larger one. File audio goes out in 80 ms
(2 560-byte) frames; microphone audio in the smaller blocks the AudioWorklet delivers.

**Receive results:**
```json
{
  "type": "result",
  "is_final": true,
  "text": "...",
  "committed_text": "...",
  "unstable_text": "...",
  "language_code": "ko",
  "engine_name": "sherpa_onnx_zipformer",
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
cd web
npm test              # Vitest unit tests for lib/ (no browser or running stack needed)
npm run type-check    # tsc --noEmit
npm run lint
```

The unit tests cover the pure modules under `web/lib/` — transcript merging, the WebSocket
client's session and reconnect handling (against a fake socket), settings validation, SRT
and display formatting. Components are not unit-tested; check UI changes in a browser
against a running stack (the workspace's `e2e-test` skill describes how).

The FastAPI proxy (`api/`) has no test suite yet.

## License

MIT
