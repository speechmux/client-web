"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionState, RecognitionResult } from "@/lib/speechmux-ws";
import { SpeechMuxWsClient } from "@/lib/speechmux-ws";
import { TranscriptView, applyResult, applyDone } from "@/components/TranscriptView";
import type { TranscriptLine } from "@/components/TranscriptView";
import { useAudioCapture, type InputMode } from "@/components/AudioCapture";
import { BatchPanel } from "@/components/BatchPanel";

const THEME_KEY = "speechmux_theme";
const THEME_COLORS: Record<string, string> = { dark: "#1c2128", light: "#f6f8fa" };
/** Auto-stop microphone after this many ms without any audio chunks. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

// Derive WebSocket URL from the page's own hostname so remote clients connect correctly.
// When NEXT_PUBLIC_API_PORT is empty (e.g. Caddy same-origin HTTPS mode), use window.location.host
// so the WebSocket upgrade goes to the same origin and Caddy proxies it to FastAPI.
const API_PORT = process.env.NEXT_PUBLIC_API_PORT ?? "";
const WS_URL =
  typeof window !== "undefined"
    ? (() => {
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const host = API_PORT
          ? `${window.location.hostname}:${API_PORT}`
          : window.location.host;
        return `${proto}://${host}/ws/stream`;
      })()
    : `ws://localhost:${API_PORT || "8000"}/ws/stream`;

type StatusKind = "idle" | "ok" | "active" | "warn" | "error";

interface StatusEntry {
  text: string;
  kind: StatusKind;
}

type ThemeMode = "system" | "dark" | "light";
type NetworkProfile = "realtime" | "balanced" | "saver";

interface LogEntry {
  id: string;
  text: string;
  level: "info" | "warn" | "error";
}

const PROFILE_DECODE: Record<NetworkProfile, "realtime" | "accurate"> = {
  realtime: "realtime",
  balanced: "realtime",
  saver: "accurate",
};

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
    case "RECONNECT_FAILED": return "Connection lost after multiple retries — please restart.";
    case "PROXY_UPSTREAM_DOWN": return "Cannot reach the speech server. Is the server running?";
    default:
      if (code.startsWith("ERR3") || code.startsWith("ERR4"))
        return `Internal server error (${code}) — please try again.`;
      return `Error ${code} — please try again.`;
  }
}

function nowHhmmss(): string {
  return new Date().toISOString().slice(11, 19);
}

function makeLog(text: string, level: LogEntry["level"] = "info"): LogEntry {
  return { id: `${Date.now()}-${Math.random()}`, text: `[${nowHhmmss()}] ${text}`, level };
}

const IDLE_CAPTURE: StatusEntry  = { text: "Idle",    kind: "idle" };
const IDLE_TRANSFER: StatusEntry = { text: "Idle",    kind: "idle" };
const IDLE_RESULT: StatusEntry   = { text: "Waiting", kind: "idle" };

export default function HomePage(): React.JSX.Element {
  const [inputMode, setInputMode] = useState<InputMode | "batch">("mic");
  const [languageCode, setLanguageCode] = useState("ko");
  const [engineHint, setEngineHint] = useState("");
  const [networkProfile, setNetworkProfile] = useState<NetworkProfile>("balanced");
  const [vadThreshold, setVadThreshold] = useState(0.65);
  const [vadSilence, setVadSilence] = useState(0.8);
  const [realtimePacing, setRealtimePacing] = useState(true);
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [customWsUrl, setCustomWsUrl] = useState("");

  const [isRunning, setIsRunning] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<StatusEntry>({ text: "Idle", kind: "idle" });
  const [captureStatus, setCaptureStatus] = useState<StatusEntry>(IDLE_CAPTURE);
  const [transferStatus, setTransferStatus] = useState<StatusEntry>(IDLE_TRANSFER);
  const [resultStatus, setResultStatus] = useState<StatusEntry>(IDLE_RESULT);
  /** Dismissable error banner for user-facing error messages. */
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [selectedFileName, setSelectedFileName] = useState("");

  const clientRef = useRef<SpeechMuxWsClient | null>(null);
  const selectedFileRef = useRef<File | null>(null);
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
  /** True if at least one final result was received in the current session. */
  const hasResultRef = useRef(false);
  /** Timestamp of the last audio chunk sent — used for idle-timeout detection. */
  const lastAudioRef = useRef<number>(0);

  // ── Theme ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY) as ThemeMode | null;
      if (saved === "dark" || saved === "light" || saved === "system") {
        setThemeMode(saved);
      }
    } catch (_) { /* no-op */ }
  }, []);

  const applyTheme = useCallback((mode: ThemeMode, persist: boolean) => {
    setThemeMode(mode);
    if (mode === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.dataset.theme = mode;
    }
    const resolved =
      mode === "system"
        ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
        : mode;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_COLORS[resolved] ?? THEME_COLORS.dark);
    if (persist) {
      try { localStorage.setItem(THEME_KEY, mode); } catch (_) { /* no-op */ }
    }
  }, []);

  const handleThemeChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      applyTheme(event.target.value as ThemeMode, true);
    },
    [applyTheme],
  );

  // ── WS URL ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    setCustomWsUrl(WS_URL);
  }, []);

  // ── Logging ────────────────────────────────────────────────────────────────

  const addLog = useCallback((text: string, level: LogEntry["level"] = "info") => {
    setLogs((prev) => [makeLog(text, level), ...prev].slice(0, 120));
  }, []);

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

  // ── Result / session callbacks ─────────────────────────────────────────────

  const handleResult = useCallback((result: RecognitionResult) => {
    if (isDoneRef.current) return; // Ignore stray results after session is done.
    const baseline = baselineRef.current;
    setTranscriptLines((prevLines) => applyResult(prevLines, result, baseline));
    if (result.isFinal) {
      hasResultRef.current = true;
      // Core's ResultAssembler calls Reset() after each EPD final, so committed_text
      // is per-segment (not cumulative). Clear the baseline so the next segment's
      // extractIncremental sees "" and returns the full committed text unchanged.
      baselineRef.current = "";
    }
    setResultStatus(result.isFinal ? { text: "Final", kind: "ok" } : { text: "Partial", kind: "active" });
    if (result.isFinal) {
      addLog(`Final: ${result.committedText || result.text || "(empty)"} | lang=${result.languageCode || "auto"}`);
    }
  }, [addLog]);

  const handleStateChange = useCallback((state: ConnectionState) => {
    setConnectionStatus(connectionStateToStatus(state));
    if (state === "done" || state === "error") {
      setIsRunning(false);
    }
    // Reset the done gate when the client starts a new connection attempt
    // (silent reconnect). Without this, results from the reconnected session
    // would be silently dropped by the isDoneRef guard in handleResult.
    if (state === "reconnecting") {
      isDoneRef.current = false;
    }
  }, []);

  const handleError = useCallback((code: string, message: string) => {
    isDoneRef.current = true;
    setTranscriptLines((prev) => applyDone(prev));
    setConnectionStatus({ text: "Error", kind: "error" });
    setResultStatus({ text: "Error", kind: "error" });
    addLog(`Server error [${code}]: ${message}`, "error");
    setErrorBanner(errorCodeToUserMessage(code));
    setIsRunning(false);
  }, [addLog]);

  const handleDone = useCallback(() => {
    isDoneRef.current = true;
    setTranscriptLines((prev) => applyDone(prev));
    setResultStatus({ text: "Done", kind: "ok" });
    setTransferStatus({ text: "Completed", kind: "ok" });
    addLog("Session done.");
    if (!hasResultRef.current) {
      addLog("No transcription result — check audio input or VAD threshold settings.", "warn");
    }
    setIsRunning(false);
  }, [addLog]);

  // ── Audio capture ──────────────────────────────────────────────────────────

  const captureMode: InputMode = inputMode === "batch" ? "file" : inputMode;

  /** Intercept audio chunks to track last-activity time for idle-timeout detection. */
  const handleAudioChunk = useCallback((chunk: Int16Array) => {
    lastAudioRef.current = Date.now();
    clientRef.current?.sendAudio(chunk);
  }, []);

  const { startMic, stopMic, sendFile, cancelFile } = useAudioCapture({
    mode: captureMode,
    isRunning,
    onAudioChunk: handleAudioChunk,
    onAudioEnd: () => clientRef.current?.end(),
    onError: (message) => {
      addLog(message, "error");
      setCaptureStatus({ text: "Error", kind: "error" });
      setIsRunning(false);
    },
  });

  // ── Idle timeout (5 min mic mode) ──────────────────────────────────────────

  useEffect(() => {
    if (!isRunning || inputMode !== "mic") return undefined;
    lastAudioRef.current = Date.now();
    const interval = setInterval(() => {
      if (Date.now() - lastAudioRef.current >= IDLE_TIMEOUT_MS) {
        addLog("No audio for 5 minutes — session auto-stopped.", "warn");
        stopMic();
        clientRef.current?.end();
        setCaptureStatus({ text: "Idle timeout", kind: "warn" });
        setIsRunning(false);
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [isRunning, inputMode, addLog, stopMic]);

  // ── Start / Stop ───────────────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    isDoneRef.current = false;
    hasResultRef.current = false;
    lastAudioRef.current = Date.now();
    baselineRef.current = "";
    setIsRunning(true);
    setErrorBanner(null);
    setCaptureStatus(IDLE_CAPTURE);
    setTransferStatus(IDLE_TRANSFER);
    setResultStatus(IDLE_RESULT);
    setConnectionStatus({ text: "Connecting", kind: "active" });

    const wsUrl = customWsUrl.trim() || WS_URL;
    const speechMuxClient = new SpeechMuxWsClient(
      wsUrl,
      {
        languageCode: languageCode === "auto" ? "" : languageCode,
        task: "transcribe",
        decodeProfile: PROFILE_DECODE[networkProfile],
        vadSilence,
        vadThreshold,
        engineHint: engineHint || undefined,
      },
      {
        onResult: handleResult,
        onStateChange: handleStateChange,
        onError: handleError,
        onDone: handleDone,
      },
    );
    clientRef.current = speechMuxClient;

    try {
      await speechMuxClient.connect();
      addLog(`Connected | profile=${networkProfile} lang=${languageCode}`);
    } catch (connectError) {
      addLog(String(connectError), "error");
      setErrorBanner("Could not connect to the server. Please check the URL and try again.");
      setConnectionStatus({ text: "Error", kind: "error" });
      setIsRunning(false);
      return;
    }

    if (inputMode === "mic") {
      try {
        await startMic();
        setCaptureStatus({ text: "Recording", kind: "active" });
        setTransferStatus({ text: "Streaming", kind: "active" });
        addLog("Microphone capture started.");
      } catch (micError) {
        addLog(String(micError), "error");
        setCaptureStatus({ text: "Error", kind: "error" });
        setIsRunning(false);
        speechMuxClient.close();
      }
    } else {
      const file = selectedFileRef.current;
      if (!file) {
        addLog("No file selected.", "warn");
        setIsRunning(false);
        speechMuxClient.close();
        return;
      }
      setCaptureStatus({ text: "Sending", kind: "active" });
      setTransferStatus({ text: "Sending", kind: "active" });
      addLog(`Sending file: ${selectedFileName}`);
      sendFile(file, realtimePacing)
        .then(() => {
          setCaptureStatus({ text: "Sent", kind: "ok" });
        })
        .catch((fileError: unknown) => {
          addLog(String(fileError), "error");
          setCaptureStatus({ text: "Error", kind: "error" });
          setTransferStatus({ text: "Error", kind: "error" });
          speechMuxClient.close();
          setIsRunning(false);
        });
    }
  }, [
    customWsUrl,
    languageCode,
    networkProfile,
    vadThreshold,
    vadSilence,
    realtimePacing,
    inputMode,
    handleResult,
    handleStateChange,
    handleError,
    handleDone,
    startMic,
    sendFile,
    addLog,
    selectedFileName,
  ]);

  const handleStop = useCallback(() => {
    if (inputMode === "mic") {
      stopMic();
    } else {
      cancelFile();
    }
    clientRef.current?.end();
    setCaptureStatus({ text: "Stopped", kind: "idle" });
    setTransferStatus({ text: "Stopped", kind: "idle" });
    addLog("Stopped by user.");
    setIsRunning(false);
  }, [inputMode, stopMic, cancelFile, addLog]);

  const handleClear = useCallback(() => {
    setTranscriptLines([]);
    baselineRef.current = "";
    clientRef.current?.close();
    addLog("Transcript cleared.");
  }, [addLog]);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    selectedFileRef.current = file;
    setSelectedFileName(file?.name ?? "");
  }, []);

  const handleInputModeChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      if (isRunning) return;
      setInputMode(event.target.value as InputMode | "batch");
    },
    [isRunning],
  );

  // ── Transcript export ──────────────────────────────────────────────────────

  const handleCopyTranscript = useCallback(() => {
    const text = transcriptLines
      .filter((line) => line.isFinal)
      .map((line) => line.displayText)
      .filter(Boolean)
      .join("\n");
    navigator.clipboard.writeText(text).then(
      () => addLog("Transcript copied to clipboard."),
      () => addLog("Failed to copy transcript to clipboard.", "warn"),
    );
  }, [transcriptLines, addLog]);

  const handleDownloadTranscript = useCallback(() => {
    const text = transcriptLines
      .filter((line) => line.isFinal)
      .map((line) => line.displayText)
      .filter(Boolean)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = `transcript-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
    anchor.click();
    URL.revokeObjectURL(blobUrl);
    addLog("Transcript downloaded.");
  }, [transcriptLines, addLog]);

  // ──────────────────────────────────────────────────────────────────────────

  const isFileMode = inputMode === "file";
  const isBatchMode = inputMode === "batch";
  const hasTranscript = transcriptLines.some((line) => line.isFinal && line.displayText);

  return (
    <>
      <main className={`app${isRunning ? " is-running" : ""}`}>
        {/* Hero */}
        <header className="hero card">
          <div>
            <p className="eyebrow">SpeechMux</p>
            <h1>Web Client</h1>
          </div>
          <p className="muted">
            Stream audio to SpeechMux Core and see live transcripts.
          </p>
        </header>

        {/* Error banner */}
        {errorBanner && (
          <div className="card error-banner" role="alert">
            <p>{errorBanner}</p>
            <button
              type="button"
              className="ghost"
              onClick={() => setErrorBanner(null)}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        {/* Status grid */}
        <section className="card status-grid" aria-label="Live status">
          <div className="status-box">
            <p>Connection</p>
            <strong data-state={connectionStatus.kind}>{connectionStatus.text}</strong>
          </div>
          <div className="status-box">
            <p>Capture</p>
            <strong data-state={captureStatus.kind}>{captureStatus.text}</strong>
          </div>
          <div className="status-box">
            <p>Transfer</p>
            <strong data-state={transferStatus.kind}>{transferStatus.text}</strong>
          </div>
          <div className="status-box">
            <p>Result</p>
            <strong data-state={resultStatus.kind}>{resultStatus.text}</strong>
          </div>
        </section>

        {/* Controls (collapses when running) */}
        <section className="card controls" aria-label="Controls">
          <div className="row">
            <label className="field">
              <span>Input</span>
              <select
                value={inputMode}
                onChange={handleInputModeChange}
                disabled={isRunning}
              >
                <option value="mic">Microphone (live)</option>
                <option value="file">Audio file</option>
                <option value="batch">Batch</option>
              </select>
            </label>
            <label className="field">
              <span>Language</span>
              <select
                value={languageCode}
                onChange={(e) => setLanguageCode(e.target.value)}
                disabled={isRunning}
              >
                <option value="auto">Auto</option>
                <option value="ko">Korean</option>
                <option value="en">English</option>
                <option value="ja">Japanese</option>
                <option value="zh">Chinese</option>
              </select>
            </label>
            <label className="field">
              <span>Engine</span>
              <select
                value={engineHint}
                onChange={(e) => setEngineHint(e.target.value)}
                disabled={isRunning}
              >
                <option value="">Auto</option>
                <option value="whisper-mlx">Whisper (MLX)</option>
                <option value="sherpa-onnx">Sherpa-ONNX</option>
              </select>
            </label>
          </div>

          {/* File field */}
          <label className={`field file-upload-panel${isFileMode ? "" : " is-collapsed"}`} aria-hidden={!isFileMode}>
            <span>Audio file</span>
            <input
              type="file"
              accept="audio/*"
              onChange={handleFileChange}
              disabled={isRunning}
              className="visually-hidden-file"
              id="audio-file-input"
            />
            <button
              type="button"
              className="file-picker-btn"
              aria-describedby="file-hint"
              onClick={() => document.getElementById("audio-file-input")?.click()}
              disabled={isRunning}
            >
              Choose file
            </button>
            <small className="muted" id="file-hint">
              {selectedFileName || "No file selected"}
            </small>
          </label>

          {/* Network / advanced */}
          <div className="row">
            <label className="field">
              <span>Network profile</span>
              <select
                value={networkProfile}
                onChange={(e) => setNetworkProfile(e.target.value as NetworkProfile)}
                disabled={isRunning}
              >
                <option value="balanced">Balanced</option>
                <option value="realtime">Low latency</option>
                <option value="saver">Low power / data</option>
              </select>
            </label>
            {isFileMode && (
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={realtimePacing}
                  onChange={(e) => setRealtimePacing(e.target.checked)}
                  disabled={isRunning}
                />
                <span>Realtime pacing</span>
              </label>
            )}
          </div>

          <details className="advanced">
            <summary>Advanced</summary>
            <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
              <label className="field">
                <span>Theme</span>
                <select value={themeMode} onChange={handleThemeChange}>
                  <option value="system">System</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <label className="field">
                <span>VAD threshold ({vadThreshold.toFixed(2)})</span>
                <input
                  type="range"
                  min={0.3}
                  max={0.95}
                  step={0.05}
                  value={vadThreshold}
                  onChange={(e) => setVadThreshold(Number(e.target.value))}
                  disabled={isRunning}
                />
              </label>
              <label className="field">
                <span>VAD silence ({vadSilence.toFixed(1)}s)</span>
                <input
                  type="range"
                  min={0.3}
                  max={3.0}
                  step={0.1}
                  value={vadSilence}
                  onChange={(e) => setVadSilence(Number(e.target.value))}
                  disabled={isRunning}
                />
              </label>
              <label className="field">
                <span>WebSocket URL</span>
                <input
                  type="text"
                  value={customWsUrl}
                  onChange={(e) => setCustomWsUrl(e.target.value)}
                  spellCheck={false}
                  disabled={isRunning}
                />
              </label>
            </div>
          </details>
        </section>

        {/* Batch panel */}
        {isBatchMode && (
          <section className="card" aria-label="Batch processing">
            <BatchPanel
              wsUrl={customWsUrl || WS_URL}
              sessionConfig={{
                languageCode: languageCode === "auto" ? "" : languageCode,
                task: "transcribe",
                decodeProfile: "accurate",
                vadSilence: 0.8,
                vadThreshold: 0.5,
              }}
            />
          </section>
        )}

        {/* Transcript */}
        {!isBatchMode && (
          <section className="card transcript" aria-live="polite">
            <div className="section-head">
              <h2>Transcript</h2>
              <div className="button-row">
                <button
                  type="button"
                  className="ghost"
                  onClick={handleCopyTranscript}
                  disabled={!hasTranscript}
                  title="Copy transcript to clipboard"
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={handleDownloadTranscript}
                  disabled={!hasTranscript}
                  title="Download transcript as .txt"
                >
                  Download
                </button>
                <button type="button" className="ghost" onClick={handleClear} disabled={isRunning}>
                  Clear
                </button>
              </div>
            </div>
            <TranscriptView lines={transcriptLines} />
          </section>
        )}

        {/* Logs */}
        <section className="card logs" aria-label="Client logs">
          <div className="section-head">
            <h2>Logs</h2>
            <button
              type="button"
              className="ghost"
              onClick={() => setLogs([])}
            >
              Clear
            </button>
          </div>
          <div className="log-list">
            {logs.map((entry) => (
              <div key={entry.id} className={`log ${entry.level !== "info" ? entry.level : ""}`}>
                {entry.text}
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* Dock */}
      {!isBatchMode && (
        <footer className="dock">
          <button
            type="button"
            className="btn-primary"
            onClick={handleStart}
            disabled={isRunning}
          >
            {inputMode === "mic" ? "Start" : "Send file"}
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={handleStop}
            disabled={!isRunning}
          >
            Stop
          </button>
        </footer>
      )}
    </>
  );
}
