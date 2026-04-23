/**
 * speechmux-ws — browser WebSocket client for SpeechMux Core.
 *
 * Handles:
 *  - Session open / close lifecycle
 *  - Bidirectional PCM streaming
 *  - Silent Reconnect on ERR3004 (VAD failure) with exponential backoff + jitter
 *  - Overlap ring buffer (last N seconds of PCM) for seamless reconnect
 */

export interface SessionConfig {
  /** BCP-47 language code, e.g. "ko", "en". Empty string = auto-detect. */
  languageCode: string;
  /** "transcribe" or "translate". */
  task: string;
  /** "realtime" or "accurate". */
  decodeProfile: string;
  /** Seconds of silence before VAD triggers end-of-speech. */
  vadSilence: number;
  /** VAD probability threshold 0–1. */
  vadThreshold: number;
  /** Preferred engine endpoint ID (e.g. "whisper-mlx", "sherpa-onnx"). Empty = let Core decide. */
  engineHint?: string;
  /** Optional bearer token for the proxy. */
  accessToken?: string;
}

export interface RecognitionResult {
  isFinal: boolean;
  text: string;
  committedText: string;
  unstableText: string;
  languageCode: string;
  startSec: number;
  endSec: number;
}

export type ConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "error"
  | "done";

export interface SpeechMuxWsCallbacks {
  onResult: (result: RecognitionResult) => void;
  onStateChange: (state: ConnectionState) => void;
  /** Called with a server error code + message. */
  onError: (code: string, message: string) => void;
  onDone: () => void;
}

const TARGET_SAMPLE_RATE = 16000;
/** How many Int16 samples to keep in the overlap ring buffer (2 seconds). */
const OVERLAP_SAMPLES = TARGET_SAMPLE_RATE * 2;
/** Maximum reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;
/** Codes that trigger Silent Reconnect. */
const SILENT_RECONNECT_CODES = new Set(["ERR3004"]);

function reconnectDelay(attempt: number): number {
  const exponential = Math.min(500 * Math.pow(2, attempt), 10_000);
  const jitter = Math.random() * 1_000;
  return exponential + jitter;
}

/** Circular ring buffer for Int16 PCM samples. */
class PcmRingBuffer {
  private readonly buffer: Int16Array;
  private writePosition: number = 0;
  private sampleCount: number = 0;

  constructor(capacity: number) {
    this.buffer = new Int16Array(capacity);
  }

  /** Append samples from a chunk. Only the most recent `capacity` samples are kept. */
  push(chunk: Int16Array): void {
    for (let i = 0; i < chunk.length; i++) {
      this.buffer[this.writePosition] = chunk[i]!;
      this.writePosition = (this.writePosition + 1) % this.buffer.length;
      if (this.sampleCount < this.buffer.length) {
        this.sampleCount++;
      }
    }
  }

  /** Return all buffered samples in chronological order as a new Int16Array. */
  drain(): Int16Array {
    if (this.sampleCount === 0) return new Int16Array(0);
    const result = new Int16Array(this.sampleCount);
    const capacity = this.buffer.length;
    const startPosition = this.sampleCount < capacity
      ? 0
      : this.writePosition;
    for (let i = 0; i < this.sampleCount; i++) {
      result[i] = this.buffer[(startPosition + i) % capacity]!;
    }
    return result;
  }

  reset(): void {
    this.writePosition = 0;
    this.sampleCount = 0;
  }
}

export class SpeechMuxWsClient {
  private readonly url: string;
  private readonly config: SessionConfig;
  private readonly callbacks: SpeechMuxWsCallbacks;

  private ws: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private reconnectAttempt: number = 0;
  private committedText: string = "";
  private readonly overlapBuffer = new PcmRingBuffer(OVERLAP_SAMPLES);
  private isEnded: boolean = false;
  /** True only after the server has confirmed the session. Prevents audio
   *  from being sent to a new socket before the session handshake completes. */
  private _sessionReady: boolean = false;

  constructor(url: string, config: SessionConfig, callbacks: SpeechMuxWsCallbacks) {
    this.url = url;
    this.config = config;
    this.callbacks = callbacks;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Open the session. Resolves once the server confirms `{"type":"session"}`.
   *  Throws if called while a session is already active or connecting. */
  async connect(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(
        `connect() called while already in state "${this.state}". Call close() first.`
      );
    }
    this.isEnded = false;
    this.reconnectAttempt = 0;
    this.committedText = "";
    this.overlapBuffer.reset();
    await this._openSocket();
  }

  /**
   * Send a chunk of PCM S16LE audio.
   * Also pushes the chunk into the overlap ring buffer for reconnect use.
   * No-ops if the session handshake has not yet been confirmed by the server.
   */
  sendAudio(chunk: Int16Array): void {
    this.overlapBuffer.push(chunk);
    if (this._sessionReady && this.ws?.readyState === WebSocket.OPEN) {
      const byteOffset = chunk.byteOffset;
      const byteLength = chunk.byteLength;
      this.ws.send(chunk.buffer.slice(byteOffset, byteOffset + byteLength));
    }
  }

  /** Signal end-of-audio. The server will finalize the session after this. */
  end(): void {
    this.isEnded = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "end" }));
    }
  }

  /** Close the connection immediately without sending `{"type":"end"}`. */
  close(): void {
    this.isEnded = true;
    this._closeSocket(false);
    this._setState("idle");
  }

  get currentCommittedText(): string {
    return this.committedText;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private _setState(next: ConnectionState): void {
    if (this.state !== next) {
      this.state = next;
      this.callbacks.onStateChange(next);
    }
  }

  private _buildStartMessage(): string {
    return JSON.stringify({
      type: "start",
      session_id: `web-${Date.now()}`,
      sample_rate: TARGET_SAMPLE_RATE,
      task: this.config.task,
      language_code: this.config.languageCode,
      decode_profile: this.config.decodeProfile,
      vad_silence: this.config.vadSilence,
      vad_threshold: this.config.vadThreshold,
      engine_hint: this.config.engineHint ?? "",
    });
  }

  private _openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._setState("connecting");

      const headers: Record<string, string> = {};
      if (this.config.accessToken) {
        headers["Authorization"] = `Bearer ${this.config.accessToken}`;
      }

      // Note: browser WebSocket does not support custom headers directly.
      // The access token must be passed via a query parameter or sub-protocol
      // when using a browser. For same-origin Next.js proxy, no token is needed.
      const wsUrl = this.config.accessToken
        ? `${this.url}?token=${encodeURIComponent(this.config.accessToken)}`
        : this.url;

      const socket = new WebSocket(wsUrl);
      // Do NOT set binaryType to "arraybuffer" yet.
      // Safari bug: when binaryType="arraybuffer" and the connection negotiates
      // permessage-deflate, Safari delivers text frames as raw compressed bytes in
      // an ArrayBuffer. TextDecoder.decode() on compressed bytes produces garbage,
      // so JSON.parse fails and the session confirmation is silently dropped.
      // Fix: keep the default binaryType ("blob") until the session is confirmed,
      // so text frames always arrive as strings.  Switch to "arraybuffer" once the
      // session is confirmed so that subsequent PCM binary frames are delivered as
      // ArrayBuffer (required for Int16Array construction).
      this.ws = socket;

      let sessionConfirmed = false;
      const sessionTimeout = setTimeout(() => {
        if (!sessionConfirmed) {
          reject(new Error("Session start timeout after 10 seconds."));
          socket.close();
        }
      }, 10_000);

      socket.addEventListener("open", () => {
        socket.send(this._buildStartMessage());
      });

      socket.addEventListener("message", (event: MessageEvent) => {
        // Safari sometimes delivers text frames as ArrayBuffer when binaryType="arraybuffer"
        // is set and the connection has negotiated permessage-deflate compression.
        // Decode to string regardless of the actual JS type.
        let rawText: string;
        if (typeof event.data === "string") {
          rawText = event.data;
        } else if (event.data instanceof ArrayBuffer) {
          rawText = new TextDecoder().decode(event.data);
        } else {
          return; // Unexpected data type — skip.
        }

        let message: Record<string, unknown>;
        try {
          message = JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          return;
        }

        const messageType = String(message["type"] ?? "");

        if (messageType === "session" && !sessionConfirmed) {
          sessionConfirmed = true;
          clearTimeout(sessionTimeout);
          // Now that the session is confirmed, switch to "arraybuffer" so that
          // subsequent binary PCM frames arrive as ArrayBuffer (for Int16Array).
          // Callers only invoke sendAudio() after connect() resolves, which happens
          // below — so no PCM frames can arrive before this assignment.
          socket.binaryType = "arraybuffer";
          this._sessionReady = true;
          this._setState("ready");
          resolve();
          return;
        }

        if (messageType === "result") {
          const result: RecognitionResult = {
            isFinal: Boolean(message["is_final"]),
            text: String(message["text"] ?? ""),
            committedText: String(message["committed_text"] ?? ""),
            unstableText: String(message["unstable_text"] ?? ""),
            languageCode: String(message["language_code"] ?? ""),
            startSec: Number(message["start_sec"] ?? 0),
            endSec: Number(message["end_sec"] ?? 0),
          };
          if (result.isFinal && result.committedText) {
            this.committedText = result.committedText;
          }
          this.callbacks.onResult(result);
          return;
        }

        if (messageType === "done") {
          this._setState("done");
          this.callbacks.onDone();
          return;
        }

        if (messageType === "error") {
          const errorCode = String(message["code"] ?? "");
          const errorMessage = String(message["message"] ?? "Unknown server error");

          if (!sessionConfirmed) {
            clearTimeout(sessionTimeout);
            reject(new Error(errorMessage));
            return;
          }

          if (SILENT_RECONNECT_CODES.has(errorCode) && !this.isEnded) {
            this._attemptSilentReconnect();
          } else {
            // Terminal error: close the socket before notifying callers so
            // the connection is released regardless of what onError does.
            this._closeSocket(false);
            this._setState("error");
            this.callbacks.onError(errorCode, errorMessage);
          }
        }
      });

      socket.addEventListener("close", () => {
        if (!sessionConfirmed) {
          clearTimeout(sessionTimeout);
          reject(new Error("Connection closed before session was ready."));
          return;
        }
        if (!this.isEnded && this.state !== "done" && this.state !== "error") {
          // Unexpected close — attempt silent reconnect.
          this._attemptSilentReconnect();
        }
      });

      socket.addEventListener("error", () => {
        if (!sessionConfirmed) {
          clearTimeout(sessionTimeout);
          reject(new Error("WebSocket connection failed."));
        }
      });
    });
  }

  private _closeSocket(sendEnd: boolean): void {
    this._sessionReady = false;
    const socket = this.ws;
    this.ws = null;
    if (!socket) return;
    try {
      if (sendEnd && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "end" }));
      }
      socket.close();
    } catch {
      // Ignore errors during cleanup.
    }
  }

  private _attemptSilentReconnect(): void {
    if (this.isEnded) return;

    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this._setState("error");
      this.callbacks.onError(
        "RECONNECT_FAILED",
        `Reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts.`
      );
      return;
    }

    this._setState("reconnecting");
    this._closeSocket(false);

    const attempt = this.reconnectAttempt;
    this.reconnectAttempt++;
    const delay = reconnectDelay(attempt);

    setTimeout(async () => {
      if (this.isEnded) return;
      try {
        await this._openSocket();
        // Replay overlap buffer to avoid gap in audio context.
        const overlapChunk = this.overlapBuffer.drain();
        if (overlapChunk.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(overlapChunk.buffer.slice(
            overlapChunk.byteOffset,
            overlapChunk.byteOffset + overlapChunk.byteLength,
          ));
        }
        this.reconnectAttempt = 0;
      } catch {
        this._attemptSilentReconnect();
      }
    }, delay);
  }
}
