"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, CircleCheck, Download, Loader, Trash2, TriangleAlert, X } from "lucide-react";
import type { ConnectionState, RecognitionResult, SessionConfig } from "@/lib/speechmux-ws";
import { RECONNECT_OVERLAP_SEC, SpeechMuxWsClient } from "@/lib/speechmux-ws";
import { useAudioCapture, type InputMode } from "@/components/AudioCapture";
import { BatchPanel } from "@/components/BatchPanel";
import { CopyButton } from "@/components/CopyButton";
import { LogsPanel, type LogEntry } from "@/components/LogsPanel";
import { SessionDock, type SessionPhase } from "@/components/SessionDock";
import { SetupPanel, type SelectedFileInfo } from "@/components/SetupPanel";
import { StatusStrip, type StatusEntry, type StatusItem } from "@/components/StatusStrip";
import { ThemeToggle } from "@/components/ThemeToggle";
import { TranscriptView } from "@/components/TranscriptView";
import { MAX_FILE_BYTES, TARGET_SAMPLE_RATE } from "@/lib/audio-utils";
import { downloadTextFile, fileTimestamp } from "@/lib/browser";
import {
  FALLBACK_ENGINES,
  parseEngineListResponse,
  type EngineListSource,
  type EngineOption,
} from "@/lib/engine-options";
import { formatDuration, pluralize } from "@/lib/format";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type PersistedSettings } from "@/lib/settings";
import { applyDone, applyResult, sealPartial, transcriptToText, type TranscriptLine } from "@/lib/transcript";

/** Auto-stop microphone after this many ms without any audio chunks. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

// Derive WebSocket URL from the page's own hostname so remote clients connect correctly.
// When NEXT_PUBLIC_API_PORT is empty (e.g. Caddy same-origin HTTPS mode), use window.location.host
// so the WebSocket upgrade goes to the same origin and Caddy proxies it to FastAPI.
const API_PORT = process.env.NEXT_PUBLIC_API_PORT ?? "";
/** FastAPI proxy port used when NEXT_PUBLIC_API_PORT is unset and the page is served from localhost. */
const DEFAULT_LOCAL_API_PORT = "8000";
const WS_URL =
  typeof window !== "undefined"
    ? (() => {
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const { hostname } = window.location;
        const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
        // Priority: explicit port > local dev default (FastAPI on :8000) > same origin
        // (Caddy/reverse-proxy mode, where the WS upgrade is proxied by the page's own host).
        const host = API_PORT
          ? `${hostname}:${API_PORT}`
          : isLocal
            ? `${hostname}:${DEFAULT_LOCAL_API_PORT}`
            : window.location.host;
        return `${proto}://${host}/ws/stream`;
      })()
    : `ws://localhost:${API_PORT || DEFAULT_LOCAL_API_PORT}/ws/stream`;

/** "loading" until `/api/engines` answers; afterwards where the list came from. */
type EngineListState = "loading" | EngineListSource;

/** Shown under the Engine selector when the list is not Core's own. */
const ENGINE_LIST_HINT: Partial<Record<EngineListState, string>> = {
  unreachable: "Could not reach Core — this is the default engine list and may not match what is running.",
  no_healthy_engines: "Core reports no healthy engine — showing the default engine list.",
};

/** Why the browser cannot capture the microphone at all (known before Start is pressed). */
type MicBlock = "insecure" | "unsupported";

const MIC_BLOCK_TEXT: Record<MicBlock, { dock: string; notice: string }> = {
  insecure: {
    dock: "Microphone needs HTTPS or localhost",
    notice:
      "Browsers only allow microphone capture on HTTPS or localhost. Open this page over HTTPS, or use Audio file instead.",
  },
  unsupported: {
    dock: "This browser cannot capture audio",
    notice: "This browser does not support microphone capture. Use Audio file instead.",
  },
};

/** Figures shown under the transcript once the server reports the session done. */
interface SessionSummary {
  /** Final results that carried text. */
  utterances: number;
  /** Seconds of audio captured or sent in the session. */
  audioSec: number;
  /** Engine name reported by the server, else the engine the user picked; "" when neither is known. */
  engine: string;
}

function connectionStateToStatus(state: ConnectionState): StatusEntry {
  switch (state) {
    case "idle":         return { text: "Idle",         kind: "idle" };
    case "connecting":   return { text: "Connecting",   kind: "active" };
    case "ready":        return { text: "Ready",        kind: "active" };
    case "reconnecting": return { text: "Reconnecting", kind: "warn" };
    case "error":        return { text: "Error",        kind: "error" };
    case "done":         return { text: "Done",         kind: "ok" };
  }
}

/** Map server error codes to user-visible messages. */
function errorCodeToUserMessage(code: string): string {
  switch (code) {
    case "ERR1011": return "Server is busy — please try again later.";
    case "ERR1012": return "Rate limit reached — please wait before retrying.";
    case "ERR1013": return "Server is temporarily unavailable for maintenance.";
    case "ERR2001": return "Processing timed out — please try again.";
    case "RECONNECT_FAILED": return "The connection was lost and could not be restored. Start a new session to try again.";
    case "PROXY_UPSTREAM_DOWN": return "Cannot reach the speech server. Is the server running?";
    default:
      if (code.startsWith("ERR3") || code.startsWith("ERR4"))
        return `Internal server error (${code}) — please try again.`;
      return `Error ${code} — please try again.`;
  }
}

/** Map getUserMedia / AudioContext failures to user-visible messages. */
function micErrorToUserMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was denied. Allow the microphone for this site in your browser settings and try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone was found. Connect a microphone and try again.";
    case "NotReadableError":
    case "TrackStartError":
      return "The microphone is in use by another application or could not be started.";
    case "OverconstrainedError":
      return "The microphone does not support the requested audio settings.";
    default:
      return error instanceof Error ? error.message : "Could not start the microphone.";
  }
}

/** Explain a failed connect(): unreachable server versus a session the server refused. */
function connectErrorToUserMessage(error: unknown, wsUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "WebSocket connection failed." ||
    message === "Connection closed before session was ready."
  ) {
    return `Could not connect to ${wsUrl}. Check that the server is running and that the WebSocket URL under Advanced is correct.`;
  }
  if (message.startsWith("Session start timeout")) {
    return "The server did not confirm the session within 10 seconds. Please try again.";
  }
  return `The server refused the session: ${message}`;
}

/** What the transcript area says while it has no lines yet, by session phase. */
function transcriptEmptyState(
  phase: SessionPhase,
  isFileMode: boolean,
  hasFile: boolean,
  micUnavailable: boolean,
): { title: string; hint: string } {
  switch (phase) {
    case "connecting":
      return { title: "Connecting…", hint: "Setting up the session with the server." };
    case "permission":
      return { title: "Waiting for the microphone…", hint: "Allow microphone access if your browser asks." };
    case "reconnecting":
      return { title: "Reconnecting…", hint: "Transcription resumes when the connection is back." };
    case "finishing":
      return { title: "Finishing…", hint: "Waiting for the last results from the server." };
    case "live":
      return isFileMode
        ? { title: "Transcribing…", hint: "Text appears here as the file is recognised." }
        : { title: "Listening…", hint: "Text appears here as soon as speech is recognised." };
    case "idle":
      if (!isFileMode) {
        return micUnavailable
          ? { title: "No transcript yet", hint: "The microphone is not available on this page. Use Audio file instead." }
          : { title: "No transcript yet", hint: "Press Start and speak — text appears here as you talk." };
      }
      return hasFile
        ? { title: "No transcript yet", hint: "Press Send file to transcribe the selected file." }
        : { title: "No transcript yet", hint: "Choose an audio file, then press Send file." };
  }
}

function nowHhmmss(): string {
  return new Date().toISOString().slice(11, 19);
}

function makeLog(text: string, level: LogEntry["level"] = "info"): LogEntry {
  return { id: `${Date.now()}-${Math.random()}`, text: `[${nowHhmmss()}] ${text}`, level };
}

const IDLE_CONNECTION: StatusEntry = { text: "Idle",  kind: "idle" };
const IDLE_CAPTURE: StatusEntry  = { text: "Idle",    kind: "idle" };
const IDLE_TRANSFER: StatusEntry = { text: "Idle",    kind: "idle" };
const IDLE_RESULT: StatusEntry   = { text: "Waiting", kind: "idle" };

export default function HomePage(): React.JSX.Element {
  // ── Settings (persisted) ───────────────────────────────────────────────────

  const [settings, setSettings] = useState<PersistedSettings>(DEFAULT_SETTINGS);
  /** False until the saved settings are read, so the defaults never overwrite them. */
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const { inputMode, languageCode, engineHint, decodeProfile, vadThreshold, vadSilence, realtimePacing } = settings;
  const [customWsUrl, setCustomWsUrl] = useState("");

  const updateSettings = useCallback((patch: Partial<PersistedSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  useEffect(() => {
    setSettings(loadSettings());
    setSettingsLoaded(true);
    setCustomWsUrl(WS_URL);
  }, []);

  useEffect(() => {
    if (settingsLoaded) saveSettings(settings);
  }, [settings, settingsLoaded]);

  // ── Session state ──────────────────────────────────────────────────────────

  const [isRunning, setIsRunning] = useState(false);
  /** True between Stop and the server's done/error: results may still arrive. */
  const [isFinishing, setIsFinishing] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<StatusEntry>(IDLE_CONNECTION);
  const [captureStatus, setCaptureStatus] = useState<StatusEntry>(IDLE_CAPTURE);
  const [transferStatus, setTransferStatus] = useState<StatusEntry>(IDLE_TRANSFER);
  const [resultStatus, setResultStatus] = useState<StatusEntry>(IDLE_RESULT);
  /** Dismissable error banner for user-facing error messages. */
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  /** Set while the WebSocket client is retrying a dropped connection. */
  const [reconnectInfo, setReconnectInfo] = useState<{ attempt: number; maxAttempts: number } | null>(null);
  /** Date.now() when audio capture (mic) or sending (file) began; drives the dock clock. */
  const [captureStartedAt, setCaptureStartedAt] = useState<number | null>(null);
  /** True while getUserMedia is pending — typically the browser's permission prompt is open. */
  const [awaitingMic, setAwaitingMic] = useState(false);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);
  /**
   * Whether the setup form is expanded. It folds into a one-line summary when a
   * session starts and stays folded afterwards, so the transcript keeps the room —
   * until the user reopens it or a failed start sends them back to the settings.
   */
  const [setupOpen, setSetupOpen] = useState(true);

  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [selectedFile, setSelectedFile] = useState<SelectedFileInfo | null>(null);
  const [engineOptions, setEngineOptions] = useState<EngineOption[]>(FALLBACK_ENGINES);
  const [engineListState, setEngineListState] = useState<EngineListState>("loading");
  const [micBlock, setMicBlock] = useState<MicBlock | null>(null);
  const [micLevel, setMicLevel] = useState<number>(0);
  const [uploadProgress, setUploadProgress] = useState<number>(0);

  const clientRef = useRef<SpeechMuxWsClient | null>(null);
  const selectedFileRef = useRef<File | null>(null);
  /**
   * Incremented by every Start and by everything that ends a session. handleStart
   * compares it after each await to learn whether its session was stopped meanwhile.
   */
  const runIdRef = useRef(0);
  /** Input mode of the session in progress; the selector may not change while it runs. */
  const sessionModeRef = useRef<InputMode>("mic");
  /** Engine name captured at session start; attached to every TranscriptLine. */
  const sessionEngineRef = useRef<string>("auto");
  /** Engine name most recently reported by the server in this session. */
  const reportedEngineRef = useRef("");
  /**
   * Baseline for extractIncremental — the committedText of the last final result.
   * A ref (not state) so it can be read synchronously inside handleResult without
   * the nested-setState anti-pattern that caused duplicate/stale lines.
   */
  const baselineRef = useRef("");
  /**
   * Set to true when the server sends `done`. Prevents stray result callbacks
   * (e.g. from a late Core message) from appending lines after the session ends.
   */
  const isDoneRef = useRef(false);
  /** Number of final results with text received in the current session. */
  const finalCountRef = useRef(0);
  /** PCM samples handed to the WebSocket client in the current session. */
  const sentSamplesRef = useRef(0);
  /** Timestamp of the last audio chunk sent — used for idle-timeout detection. */
  const lastAudioRef = useRef<number>(0);
  /** True from a reconnect attempt until the connection is ready again. */
  const reconnectingRef = useRef(false);
  /** Latest capture-error handler; lets useAudioCapture call code defined after it. */
  const captureErrorHandlerRef = useRef<(message: string) => void>(() => {});

  // ── Environment checks ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!window.isSecureContext) {
      setMicBlock("insecure");
    } else if (!navigator.mediaDevices?.getUserMedia) {
      setMicBlock("unsupported");
    }
  }, []);

  // ── F9: Engine list from server ───────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    fetch("/api/engines")
      .then((res) => res.json())
      .then((body: unknown) => {
        if (cancelled) return;
        const parsed = parseEngineListResponse(body);
        if (!parsed) {
          setEngineListState("unreachable");
          return;
        }
        setEngineOptions(parsed.engines);
        setEngineListState(parsed.source);
      })
      .catch(() => {
        // The route itself failed: keep FALLBACK_ENGINES and say so.
        if (!cancelled) setEngineListState("unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A saved engine that Core no longer lists as healthy falls back to Auto. When the
  // list is only the built-in fallback, the saved choice is kept (and shown) instead.
  useEffect(() => {
    if (!settingsLoaded || engineListState !== "core") return;
    setSettings((prev) =>
      prev.engineHint && !engineOptions.some((option) => option.id === prev.engineHint)
        ? { ...prev, engineHint: "" }
        : prev,
    );
  }, [settingsLoaded, engineListState, engineOptions]);

  // ── Logging ────────────────────────────────────────────────────────────────

  const addLog = useCallback((text: string, level: LogEntry["level"] = "info") => {
    setLogs((prev) => [makeLog(text, level), ...prev].slice(0, 120));
  }, []);

  const handleClearLogs = useCallback(() => setLogs([]), []);

  // ── Lifecycle: beforeunload ────────────────────────────────────────────────

  useEffect(() => {
    const onBeforeUnload = (): void => {
      clientRef.current?.end();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // ── Lifecycle: Page Visibility API ────────────────────────────────────────

  useEffect(() => {
    if (!isRunning || inputMode !== "mic") return undefined;
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        addLog("Tab moved to background — microphone audio may be suspended.", "warn");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [isRunning, inputMode, addLog]);

  // ── Audio capture ──────────────────────────────────────────────────────────

  const captureMode: InputMode = inputMode === "batch" ? "file" : inputMode;

  /** Intercept audio chunks to track last-activity time for idle-timeout detection. */
  const handleAudioChunk = useCallback((chunk: Int16Array) => {
    lastAudioRef.current = Date.now();
    sentSamplesRef.current += chunk.length;
    clientRef.current?.sendAudio(chunk);
  }, []);

  /** Re-render per whole percent, not per 80 ms chunk. */
  const handleUploadProgress = useCallback((ratio: number) => {
    setUploadProgress((prev) => (Math.round(prev * 100) === Math.round(ratio * 100) ? prev : ratio));
  }, []);

  const { startMic, stopMic, sendFile, cancelFile } = useAudioCapture({
    mode: captureMode,
    isRunning,
    onAudioChunk: handleAudioChunk,
    onAudioEnd: () => clientRef.current?.end(),
    onError: (message) => captureErrorHandlerRef.current(message),
    onRmsLevel: setMicLevel,
    onUploadProgress: handleUploadProgress,
  });

  // ── Result / session callbacks ─────────────────────────────────────────────

  const handleResult = useCallback((result: RecognitionResult) => {
    if (isDoneRef.current) return; // Ignore stray results after session is done.
    const baseline = baselineRef.current;
    setTranscriptLines((prevLines) => applyResult(prevLines, result, baseline, sessionEngineRef.current));
    if (result.engineName) reportedEngineRef.current = result.engineName;
    if (result.isFinal) {
      if ((result.committedText || result.text).trim()) finalCountRef.current += 1;
      // committed_text is cumulative (monotonically increasing) within a session —
      // ResultAssembler.Reset() is never called in streaming mode. Advance the
      // baseline to the current committed text so the next utterance's
      // extractIncremental returns only the new text.
      baselineRef.current = result.committedText || result.text || "";
    }
    setResultStatus(result.isFinal ? { text: "Final", kind: "ok" } : { text: "Partial", kind: "active" });
    if (result.isFinal) {
      addLog(`Final: ${result.committedText || result.text || "(empty)"} | lang=${result.languageCode || "auto"}`);
    }
  }, [addLog]);

  const handleStateChange = useCallback((state: ConnectionState) => {
    setConnectionStatus(connectionStateToStatus(state));
    if (state === "ready" && reconnectingRef.current) {
      reconnectingRef.current = false;
      setReconnectInfo(null);
      addLog("Reconnected.");
    }
    if (state === "done" || state === "error") {
      setIsRunning(false);
    }
    // Reset the done gate when the client starts a new connection attempt
    // (silent reconnect). Without this, results from the reconnected session
    // would be silently dropped by the isDoneRef guard in handleResult.
    if (state === "reconnecting") {
      isDoneRef.current = false;
    }
  }, [addLog]);

  const handleReconnecting = useCallback((attempt: number, maxAttempts: number) => {
    if (!reconnectingRef.current) {
      // The server session is gone, and with it the final for the line in progress.
      // Keep what was heard; the reconnected session starts a new line and a new baseline.
      setTranscriptLines((prev) => sealPartial(prev));
      baselineRef.current = "";
    }
    reconnectingRef.current = true;
    setReconnectInfo({ attempt, maxAttempts });
    setConnectionStatus({ text: `Reconnecting ${attempt}/${maxAttempts}`, kind: "warn" });
    addLog(`Connection lost — reconnect attempt ${attempt} of ${maxAttempts}.`, "warn");
  }, [addLog]);

  /** Common teardown once the server (or the connection) has ended the session. */
  const settleSession = useCallback(() => {
    runIdRef.current += 1;
    isDoneRef.current = true;
    reconnectingRef.current = false;
    cancelFile();
    setTranscriptLines((prev) => applyDone(prev));
    // The server ended the session while audio was still flowing: capture stops with it.
    setCaptureStatus((prev) => (prev.kind === "active" ? { text: "Stopped", kind: "idle" } : prev));
    setReconnectInfo(null);
    setCaptureStartedAt(null);
    setAwaitingMic(false);
    setMicLevel(0);
    setUploadProgress(0);
    setIsRunning(false);
    setIsFinishing(false);
  }, [cancelFile]);

  const handleError = useCallback((code: string, message: string) => {
    settleSession();
    setConnectionStatus({ text: "Error", kind: "error" });
    setTransferStatus((prev) => (prev.kind === "active" ? { text: "Stopped", kind: "idle" } : prev));
    setResultStatus({ text: "Error", kind: "error" });
    addLog(`Server error [${code}]: ${message}`, "error");
    setErrorBanner(errorCodeToUserMessage(code));
  }, [settleSession, addLog]);

  const handleDone = useCallback(() => {
    settleSession();
    setResultStatus({ text: "Done", kind: "ok" });
    setTransferStatus({ text: "Completed", kind: "ok" });
    setSessionSummary({
      utterances: finalCountRef.current,
      audioSec: sentSamplesRef.current / TARGET_SAMPLE_RATE,
      // Core does not report the engine on every path; with Auto there is then nothing to show.
      engine: reportedEngineRef.current || (sessionEngineRef.current === "auto" ? "" : sessionEngineRef.current),
    });
    addLog("Session done.");
    if (finalCountRef.current === 0) {
      addLog("No transcription result — check audio input or VAD threshold settings.", "warn");
    }
  }, [settleSession, addLog]);

  // ── Start / Stop ───────────────────────────────────────────────────────────

  /**
   * End the session from the client side. With `graceful`, a confirmed session is
   * asked to finalize and the UI waits for the server's `done` (results may still
   * arrive); otherwise the connection is dropped at once. Returns whether it is
   * now waiting for the server.
   */
  const stopSession = useCallback((graceful: boolean, capture: StatusEntry): boolean => {
    runIdRef.current += 1;
    stopMic();
    cancelFile();
    reconnectingRef.current = false;
    setIsRunning(false);
    setCaptureStatus(capture);
    setCaptureStartedAt(null);
    setAwaitingMic(false);
    setReconnectInfo(null);
    setMicLevel(0);
    setUploadProgress(0);
    const client = clientRef.current;
    // With no audio sent there is nothing to finalize, and Core can take tens of
    // seconds to report `done` for an empty session — so that case just disconnects.
    if (graceful && client && client.connectionState === "ready" && sentSamplesRef.current > 0) {
      // Session is live: ask the server to finalize. Results may still arrive until "done".
      client.end();
      setTransferStatus({ text: "Finishing", kind: "active" });
      setResultStatus({ text: "Finishing", kind: "active" });
      setIsFinishing(true);
      return true;
    }
    // No session, or nothing to finalize: drop the connection outright and forget the
    // client so a late connect() failure does not raise an error banner.
    client?.close();
    clientRef.current = null;
    setTransferStatus({ text: "Stopped", kind: "idle" });
    setConnectionStatus(IDLE_CONNECTION);
    setIsFinishing(false);
    return false;
  }, [stopMic, cancelFile]);

  const handleStop = useCallback(() => {
    const finishing = stopSession(true, { text: "Stopped", kind: "idle" });
    addLog(finishing ? "Stopped by user — waiting for the final result." : "Stopped by user.");
  }, [stopSession, addLog]);

  // Capture failed mid-session: the microphone went away, or the file could not be decoded.
  const handleCaptureError = useCallback((message: string) => {
    addLog(message, "error");
    setErrorBanner(message);
    // A lost microphone has already sent speech worth finalizing; an undecodable file has sent nothing.
    const wasMic = sessionModeRef.current === "mic";
    stopSession(wasMic, { text: "Error", kind: "error" });
    if (!wasMic) {
      setTransferStatus({ text: "Error", kind: "error" });
      setSetupOpen(true); // back to the file picker
    }
  }, [stopSession, addLog]);

  useEffect(() => {
    captureErrorHandlerRef.current = handleCaptureError;
  }, [handleCaptureError]);

  // ── Idle timeout (5 min mic mode) ──────────────────────────────────────────

  useEffect(() => {
    if (!isRunning || inputMode !== "mic") return undefined;
    lastAudioRef.current = Date.now();
    const interval = setInterval(() => {
      if (Date.now() - lastAudioRef.current >= IDLE_TIMEOUT_MS) {
        addLog("No audio for 5 minutes — session auto-stopped.", "warn");
        stopSession(true, { text: "Idle timeout", kind: "warn" });
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [isRunning, inputMode, addLog, stopSession]);

  // Derived display flags — declared before handleStart and the keyboard shortcut
  // so both can depend on them.
  const isFileMode = inputMode === "file";
  const isBatchMode = inputMode === "batch";
  /** Settings are locked while anything is in flight. */
  const sessionActive = isRunning || isFinishing || batchRunning;
  /** The setup form shows as a one-line summary: always while locked, otherwise when folded. */
  const setupCollapsed = sessionActive || !setupOpen;
  const fileError =
    selectedFile && selectedFile.size > MAX_FILE_BYTES
      ? `This file is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`
      : null;
  /** Why Start is unavailable right now, in the short form shown next to the button. */
  const startBlockedReason: string | null =
    inputMode === "mic"
      ? (micBlock ? MIC_BLOCK_TEXT[micBlock].dock : null)
      : isFileMode
        ? (!selectedFile ? "Choose an audio file first" : fileError ? "The selected file is too large" : null)
        : null;

  const handleStart = useCallback(async () => {
    if (inputMode === "batch" || startBlockedReason) return;
    const mode: InputMode = inputMode;
    const file = selectedFileRef.current;
    if (mode === "file" && !file) return;

    const runId = ++runIdRef.current;
    isDoneRef.current = false;
    finalCountRef.current = 0;
    sentSamplesRef.current = 0;
    reportedEngineRef.current = "";
    reconnectingRef.current = false;
    lastAudioRef.current = Date.now();
    baselineRef.current = "";
    sessionModeRef.current = mode;
    sessionEngineRef.current = engineHint.trim() || "auto";
    setIsRunning(true);
    setIsFinishing(false);
    setSetupOpen(false);
    setErrorBanner(null);
    setSessionSummary(null);
    setReconnectInfo(null);
    setCaptureStartedAt(null);
    setAwaitingMic(false);
    setCaptureStatus(IDLE_CAPTURE);
    setTransferStatus(IDLE_TRANSFER);
    setResultStatus(IDLE_RESULT);
    setUploadProgress(0);
    setConnectionStatus({ text: "Connecting", kind: "active" });

    const wsUrl = customWsUrl.trim() || WS_URL;
    const speechMuxClient = new SpeechMuxWsClient(
      wsUrl,
      {
        languageCode: languageCode === "auto" ? "" : languageCode,
        task: "transcribe",
        decodeProfile,
        vadSilence,
        vadThreshold,
        engineHint: engineHint || undefined,
      },
      {
        onResult: handleResult,
        onStateChange: handleStateChange,
        onError: handleError,
        onDone: handleDone,
        onReconnecting: handleReconnecting,
      },
    );
    clientRef.current = speechMuxClient;
    addLog(`Connecting to ${wsUrl} …`);

    try {
      await speechMuxClient.connect();
      // The user pressed Stop while we were connecting; that client is already discarded.
      if (runIdRef.current !== runId) return;
      addLog(`Connected | profile=${decodeProfile} lang=${languageCode}`);
    } catch (connectError) {
      if (runIdRef.current !== runId) return;
      runIdRef.current += 1;
      // A session the server refused leaves its socket open; make sure it is released.
      speechMuxClient.close();
      clientRef.current = null;
      addLog(String(connectError), "error");
      setErrorBanner(connectErrorToUserMessage(connectError, wsUrl));
      setConnectionStatus({ text: "Error", kind: "error" });
      setIsRunning(false);
      setSetupOpen(true);
      return;
    }

    if (mode === "mic") {
      // getUserMedia stays pending for as long as the permission prompt is open.
      setAwaitingMic(true);
      setCaptureStatus({ text: "Requesting", kind: "active" });
      try {
        await startMic();
      } catch (micError) {
        if (runIdRef.current !== runId) return;
        addLog(`Microphone: ${String(micError)}`, "error");
        setErrorBanner(micErrorToUserMessage(micError));
        stopSession(false, { text: "Error", kind: "error" });
        setSetupOpen(true);
        return;
      }
      if (runIdRef.current !== runId) {
        // Stop was pressed while the permission prompt was open; the capture that
        // has just started belongs to no session.
        stopMic();
        return;
      }
      setAwaitingMic(false);
      setCaptureStartedAt(Date.now());
      setCaptureStatus({ text: "Recording", kind: "active" });
      setTransferStatus({ text: "Streaming", kind: "active" });
      addLog("Microphone capture started.");
      return;
    }

    if (!file) return;
    setCaptureStartedAt(Date.now());
    setCaptureStatus({ text: "Sending", kind: "active" });
    setTransferStatus({ text: "Sending", kind: "active" });
    addLog(`Sending file: ${file.name}`);
    try {
      const completed = await sendFile(file, realtimePacing);
      if (completed && runIdRef.current === runId) {
        setCaptureStatus({ text: "Sent", kind: "ok" });
      }
    } catch (sendError) {
      if (runIdRef.current !== runId) return;
      addLog(String(sendError), "error");
      stopSession(false, { text: "Error", kind: "error" });
      setTransferStatus({ text: "Error", kind: "error" });
    }
  }, [
    inputMode,
    startBlockedReason,
    customWsUrl,
    engineHint,
    languageCode,
    decodeProfile,
    vadThreshold,
    vadSilence,
    realtimePacing,
    handleResult,
    handleStateChange,
    handleError,
    handleDone,
    handleReconnecting,
    startMic,
    stopMic,
    sendFile,
    stopSession,
    addLog,
  ]);

  const handleClear = useCallback(() => {
    setTranscriptLines([]);
    setSessionSummary(null);
    baselineRef.current = "";
    addLog("Transcript cleared.");
  }, [addLog]);

  // ── File selection ─────────────────────────────────────────────────────────

  const selectFile = useCallback((file: File | null) => {
    selectedFileRef.current = file;
    setSelectedFile(file ? { name: file.name, size: file.size } : null);
  }, []);

  // ── F8: Keyboard shortcut (Space = Start/Stop) ────────────────────────────

  useEffect(() => {
    const IGNORE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"]);
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.code !== "Space") return;
      if (event.repeat) return;
      const active = document.activeElement;
      if (active && IGNORE_TAGS.has(active.tagName)) return;
      if (active && (active as HTMLElement).isContentEditable) return;
      if (isBatchMode) return;
      event.preventDefault();
      if (isRunning) {
        handleStop();
      } else if (!isFinishing && !startBlockedReason) {
        void handleStart();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isRunning, isFinishing, isBatchMode, startBlockedReason, handleStop, handleStart]);

  // ── Transcript export ──────────────────────────────────────────────────────

  const hasTranscript = useMemo(
    () => transcriptLines.some((line) => line.isFinal && line.displayText),
    [transcriptLines],
  );

  const getTranscriptText = useCallback(() => transcriptToText(transcriptLines), [transcriptLines]);

  const handleTranscriptCopied = useCallback((succeeded: boolean) => {
    if (succeeded) addLog("Transcript copied to clipboard.");
    else addLog("Failed to copy transcript to clipboard.", "warn");
  }, [addLog]);

  const handleDownloadTranscript = useCallback(() => {
    downloadTextFile(
      `transcript-${fileTimestamp()}.txt`,
      transcriptToText(transcriptLines),
      "text/plain;charset=utf-8",
    );
    addLog("Transcript downloaded.");
  }, [transcriptLines, addLog]);

  // ── Derived view state ─────────────────────────────────────────────────────

  const phase: SessionPhase = isFinishing
    ? "finishing"
    : !isRunning
      ? "idle"
      : reconnectInfo
        ? "reconnecting"
        : captureStartedAt !== null
          ? "live"
          : awaitingMic
            ? "permission"
            : "connecting";

  const emptyState = transcriptEmptyState(phase, isFileMode, selectedFile !== null, micBlock !== null);

  const statusItems: StatusItem[] = [
    { label: "Connection", status: connectionStatus },
    { label: "Capture", status: captureStatus },
    { label: "Transfer", status: transferStatus },
    { label: "Result", status: resultStatus },
  ];

  const effectiveWsUrl = customWsUrl.trim() || WS_URL;

  // Batch always asks for the accurate profile: nobody is waiting on partials there.
  const batchSessionConfig = useMemo<SessionConfig>(
    () => ({
      languageCode: languageCode === "auto" ? "" : languageCode,
      task: "transcribe",
      decodeProfile: "accurate",
      vadSilence,
      vadThreshold,
      engineHint: engineHint || undefined,
    }),
    [languageCode, vadSilence, vadThreshold, engineHint],
  );

  // A saved engine missing from the list (while it loads, or with the fallback list)
  // is still offered, so the selector never shows something other than what is sent.
  const engineChoices =
    engineHint && !engineOptions.some((option) => option.id === engineHint)
      ? [...engineOptions, { id: engineHint, label: engineHint }]
      : engineOptions;
  return (
    <>
      <main className={`app${setupCollapsed ? " is-compact" : ""}${isBatchMode ? " is-batch" : ""}`}>
        {/* Header */}
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <AudioLines size={20} />
            </span>
            <div className="brand-text">
              <h1>SpeechMux</h1>
              <p>Live speech-to-text client</p>
            </div>
          </div>
          <ThemeToggle />
        </header>

        {/* Error banner */}
        {errorBanner && (
          <div className="card banner is-error" role="alert">
            <TriangleAlert size={18} className="banner-icon" aria-hidden="true" />
            <p>{errorBanner}</p>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setErrorBanner(null)}
              aria-label="Dismiss error"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Reconnect banner */}
        {reconnectInfo && isRunning && (
          <div className="card banner is-warn" role="status">
            <Loader size={18} className="banner-icon spin" aria-hidden="true" />
            <p>
              Connection lost — reconnecting (attempt {reconnectInfo.attempt} of {reconnectInfo.maxAttempts}).
              {" "}The last {RECONNECT_OVERLAP_SEC} s of audio will be sent again once the connection is back.
            </p>
          </div>
        )}

        {/* Setup (folds into a one-line summary once a session starts) */}
        <SetupPanel
          settings={settings}
          onSettingsChange={updateSettings}
          collapsed={setupCollapsed}
          locked={sessionActive}
          onOpen={() => setSetupOpen(true)}
          onHide={!isBatchMode && transcriptLines.length > 0 ? () => setSetupOpen(false) : undefined}
          micNotice={micBlock ? MIC_BLOCK_TEXT[micBlock].notice : null}
          engineOptions={engineChoices}
          engineListLoading={engineListState === "loading"}
          engineListHint={ENGINE_LIST_HINT[engineListState]}
          selectedFile={selectedFile}
          fileError={fileError}
          onSelectFile={selectFile}
          wsUrl={customWsUrl}
          defaultWsUrl={settingsLoaded ? WS_URL : null}
          onWsUrlChange={setCustomWsUrl}
        />

        {/* Status */}
        {!isBatchMode && <StatusStrip items={statusItems} />}

        {/* Batch panel */}
        {isBatchMode && (
          <section className="card" aria-label="Batch transcription">
            <BatchPanel
              wsUrl={effectiveWsUrl}
              sessionConfig={batchSessionConfig}
              onRunningChange={setBatchRunning}
            />
          </section>
        )}

        {/* Transcript */}
        {!isBatchMode && (
          <section className="card transcript" aria-labelledby="transcript-heading">
            <div className="section-head">
              <h2 id="transcript-heading">Transcript</h2>
              <div className="button-row">
                <CopyButton
                  className="ghost"
                  label="Copy"
                  getText={getTranscriptText}
                  disabled={!hasTranscript}
                  onCopied={handleTranscriptCopied}
                />
                <button
                  type="button"
                  className="ghost"
                  onClick={handleDownloadTranscript}
                  disabled={!hasTranscript}
                >
                  <Download size={14} aria-hidden="true" />
                  <span className="btn-label">Download</span>
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={handleClear}
                  disabled={isRunning || isFinishing || transcriptLines.length === 0}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  <span className="btn-label">Clear</span>
                </button>
              </div>
            </div>
            <TranscriptView
              lines={transcriptLines}
              showWallTime={inputMode === "mic"}
              emptyTitle={emptyState.title}
              emptyHint={emptyState.hint}
              isBusy={phase !== "idle"}
            />
            {sessionSummary && (
              sessionSummary.utterances > 0 ? (
                <p className="session-summary" role="status">
                  <CircleCheck size={16} aria-hidden="true" />
                  <span>
                    Session complete — {pluralize(sessionSummary.utterances, "utterance")} from{" "}
                    {formatDuration(sessionSummary.audioSec)} of audio
                    {sessionSummary.engine && ` · ${sessionSummary.engine}`}
                  </span>
                </p>
              ) : (
                <p className="session-summary is-warn" role="status">
                  <TriangleAlert size={16} aria-hidden="true" />
                  <span>
                    No speech was recognised in {formatDuration(sessionSummary.audioSec)} of audio. Check the
                    input level, or lower the VAD threshold under Advanced.
                  </span>
                </p>
              )
            )}
          </section>
        )}

        {/* Logs — live sessions only; a batch run reports per file instead. */}
        {!isBatchMode && <LogsPanel logs={logs} onClear={handleClearLogs} />}
      </main>

      {/* Dock */}
      {!isBatchMode && (
        <SessionDock
          phase={phase}
          mode={isFileMode ? "file" : "mic"}
          blockedReason={startBlockedReason}
          startedAt={captureStartedAt}
          micLevel={micLevel}
          uploadProgress={uploadProgress}
          onStart={handleStart}
          onStop={handleStop}
        />
      )}
    </>
  );
}
