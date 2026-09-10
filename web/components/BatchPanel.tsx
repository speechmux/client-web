"use client";

import { useCallback, useRef, useState } from "react";
import { FileAudio, X, Download, Play, AlertCircle, CheckCircle, Loader } from "lucide-react";
import { SpeechMuxWsClient, type SessionConfig } from "@/lib/speechmux-ws";
import { decodeAudioFileToPcm16, chunkInt16, TARGET_SAMPLE_RATE, MAX_FILE_BYTES } from "@/lib/audio-utils";

const CHUNK_SAMPLES = (TARGET_SAMPLE_RATE * 80) / 1000;
const DEFAULT_CONCURRENCY = 4;

type BatchFileStatus = "pending" | "processing" | "done" | "error";

interface BatchFile {
  id: string;
  file: File;
  status: BatchFileStatus;
  /** Upload/decode progress 0–100. */
  progress: number;
  transcript: string;
  errorMessage: string | null;
}

/** Minimal async semaphore for capping concurrency. */
class Semaphore {
  private remaining: number;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    this.remaining = maxConcurrency;
  }

  acquire(): Promise<void> {
    if (this.remaining > 0) {
      this.remaining--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.remaining++;
    }
  }
}

function fileId(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

interface BatchPanelProps {
  wsUrl: string;
  sessionConfig: SessionConfig;
}

export function BatchPanel({ wsUrl, sessionConfig }: BatchPanelProps): React.JSX.Element {
  const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const cancelRef = useRef(false);
  const dragCountRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  // ── File list management ──────────────────────────────────────────────────

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const newEntries: BatchFile[] = [];
    for (const file of incoming) {
      const id = fileId(file);
      // Reject oversize files at selection time so the user sees it immediately,
      // instead of at run time inside decodeAudioFileToPcm16.
      const tooLarge = file.size > MAX_FILE_BYTES;
      newEntries.push({
        id,
        file,
        status: tooLarge ? "error" : "pending",
        progress: 0,
        transcript: "",
        errorMessage: tooLarge ? `File exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB limit.` : null,
      });
    }
    setBatchFiles((prev) => {
      const existingIds = new Set(prev.map((entry) => entry.id));
      const deduplicated = newEntries.filter((entry) => !existingIds.has(entry.id));
      return [...prev, ...deduplicated];
    });
  }, []);

  const removeFile = useCallback((id: string) => {
    setBatchFiles((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setBatchFiles([]);
    setExpandedIds(new Set());
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const updateFile = useCallback(
    (id: string, patch: Partial<Omit<BatchFile, "id" | "file">>) => {
      setBatchFiles((prev) =>
        prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
      );
    },
    []
  );

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragCountRef.current++;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragCountRef.current = 0;
      setIsDragging(false);
      if (event.dataTransfer.files.length > 0) {
        addFiles(event.dataTransfer.files);
      }
    },
    [addFiles]
  );

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (event.target.files && event.target.files.length > 0) {
        addFiles(event.target.files);
        event.target.value = "";
      }
    },
    [addFiles]
  );

  // ── Batch processing ──────────────────────────────────────────────────────

  async function processFile(entry: BatchFile): Promise<void> {
    updateFile(entry.id, { status: "processing", progress: 0 });

    let pcm16: Int16Array;
    try {
      pcm16 = await decodeAudioFileToPcm16(entry.file);
    } catch (decodeError) {
      updateFile(entry.id, {
        status: "error",
        errorMessage: `Decode failed: ${String(decodeError)}`,
      });
      return;
    }

    updateFile(entry.id, { progress: 10 });

    const collectedParts: string[] = [];
    let sessionEnded = false;

    const speechMuxClient = new SpeechMuxWsClient(wsUrl, sessionConfig, {
      onResult: (result) => {
        if (result.isFinal && result.committedText) {
          collectedParts.push(result.committedText);
        }
      },
      onStateChange: () => {},
      onError: (code, message) => {
        updateFile(entry.id, {
          status: "error",
          errorMessage: `[${code}] ${message}`,
        });
        sessionEnded = true;
      },
      onDone: () => {
        sessionEnded = true;
      },
    });

    try {
      await speechMuxClient.connect();
    } catch (connectError) {
      updateFile(entry.id, {
        status: "error",
        errorMessage: `Connection failed: ${String(connectError)}`,
      });
      return;
    }

    const totalChunks = Math.ceil(pcm16.length / CHUNK_SAMPLES);
    let chunkIndex = 0;

    for (const chunk of chunkInt16(pcm16, CHUNK_SAMPLES)) {
      if (cancelRef.current) {
        speechMuxClient.close();
        updateFile(entry.id, { status: "pending", progress: 0 });
        return;
      }
      speechMuxClient.sendAudio(chunk);
      chunkIndex++;
      const sendProgress = 10 + Math.round((chunkIndex / totalChunks) * 70);
      updateFile(entry.id, { progress: sendProgress });
      // Yield to avoid blocking the event loop.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    speechMuxClient.end();
    updateFile(entry.id, { progress: 80 });

    // Wait for done or error. Timeout = (audio duration × 3 + 30s), minimum 120s.
    // The multiplier accounts for slow inference; the constant covers session overhead.
    const audioDurationSec = pcm16.length / TARGET_SAMPLE_RATE;
    const timeoutMs = Math.max(audioDurationSec * 3 + 30, 120) * 1000;
    const deadline = Date.now() + timeoutMs;

    while (!sessionEnded && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }

    if (!sessionEnded) {
      speechMuxClient.close();
      updateFile(entry.id, {
        status: "error",
        errorMessage: "Transcription timeout.",
      });
      return;
    }

    const finalTranscript = collectedParts.join(" ").trim();
    updateFile(entry.id, {
      status: "done",
      progress: 100,
      transcript: finalTranscript,
    });
  }

  const startBatch = useCallback(async () => {
    const pending = batchFiles.filter((entry) => entry.status === "pending");
    if (pending.length === 0) return;

    cancelRef.current = false;
    setIsRunning(true);

    const semaphore = new Semaphore(concurrency);

    await Promise.all(
      pending.map(async (entry) => {
        await semaphore.acquire();
        try {
          await processFile(entry);
        } finally {
          semaphore.release();
        }
      })
    );

    setIsRunning(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchFiles, concurrency, wsUrl, sessionConfig]);

  const cancelBatch = useCallback(() => {
    cancelRef.current = true;
    setIsRunning(false);
  }, []);

  // ── Export ────────────────────────────────────────────────────────────────

  const downloadJson = useCallback(() => {
    const data = batchFiles
      .filter((entry) => entry.status === "done")
      .map((entry) => ({
        file: entry.file.name,
        transcript: entry.transcript,
      }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `speechmux-batch-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [batchFiles]);

  // ── Render ────────────────────────────────────────────────────────────────

  const pendingCount = batchFiles.filter((entry) => entry.status === "pending").length;
  const doneCount = batchFiles.filter((entry) => entry.status === "done").length;

  return (
    <div className="batch-panel">
      {/* Drop zone */}
      <label
        className={`drop-zone${isDragging ? " is-dragging" : ""}${isRunning ? " is-disabled" : ""}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <FileAudio className="drop-zone-icon" size={28} aria-hidden="true" />
        <p>
          Drag and drop audio files here, or <span className="drop-zone-link">browse</span>
        </p>
        <small className="muted">WAV, FLAC, MP3, OGG — max {MAX_FILE_BYTES / 1024 / 1024} MB per file</small>
        <input
          type="file"
          accept="audio/*"
          multiple
          onChange={handleFileInputChange}
          disabled={isRunning}
          className="visually-hidden-file"
        />
      </label>

      {/* Controls */}
      {batchFiles.length > 0 && (
        <div className="batch-controls">
          <label className="field-inline">
            <span className="muted">Parallel sessions</span>
            <select
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))}
              disabled={isRunning}
              aria-label="Parallel sessions"
            >
              {[1, 2, 4, 8].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>

          {!isRunning ? (
            <button
              type="button"
              className="btn-small accent"
              onClick={startBatch}
              disabled={pendingCount === 0}
            >
              <Play size={14} aria-hidden="true" />
              Start ({pendingCount} {pendingCount === 1 ? "file" : "files"})
            </button>
          ) : (
            <button type="button" className="btn-small danger" onClick={cancelBatch}>
              Cancel
            </button>
          )}

          {doneCount > 0 && (
            <button type="button" className="btn-small" onClick={downloadJson}>
              <Download size={14} aria-hidden="true" />
              Download JSON ({doneCount})
            </button>
          )}

          <button
            type="button"
            className="ghost ml-auto"
            onClick={clearAll}
            disabled={isRunning}
          >
            Clear all
          </button>
        </div>
      )}

      {/* File list */}
      {batchFiles.length > 0 && (
        <ul className="batch-file-list">
          {batchFiles.map((entry) => {
            const isExpanded = expandedIds.has(entry.id);
            return (
              <li key={entry.id} className={`batch-file is-${entry.status}`}>
                <div className="batch-file-row">
                  <StatusIcon status={entry.status} />
                  <span className="batch-file-name" title={entry.file.name}>{entry.file.name}</span>
                  <span className="batch-file-size">{formatSize(entry.file.size)}</span>
                  {!isRunning && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => removeFile(entry.id)}
                      aria-label={`Remove ${entry.file.name}`}
                      title="Remove"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>

                {entry.status === "processing" && (
                  <div
                    className="batch-progress"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={entry.progress}
                  >
                    <div className="batch-progress-bar" style={{ width: `${entry.progress}%` }} />
                  </div>
                )}

                {entry.status === "done" && entry.transcript && (
                  <>
                    <p className={`batch-transcript${isExpanded ? "" : " is-clamped"}`}>
                      {entry.transcript}
                    </p>
                    <div className="batch-file-actions">
                      <button type="button" className="link-btn" onClick={() => toggleExpanded(entry.id)}>
                        {isExpanded ? "Show less" : "Show more"}
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => { navigator.clipboard.writeText(entry.transcript).catch(() => null); }}
                      >
                        Copy
                      </button>
                    </div>
                  </>
                )}

                {entry.status === "done" && !entry.transcript && (
                  <p className="batch-transcript muted">(no speech detected)</p>
                )}

                {entry.status === "error" && entry.errorMessage && (
                  <p className="batch-error">{entry.errorMessage}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: BatchFileStatus }): React.JSX.Element {
  switch (status) {
    case "processing":
      return <Loader size={14} className="batch-status-icon processing spin" aria-label="Processing" />;
    case "done":
      return <CheckCircle size={14} className="batch-status-icon done" aria-label="Done" />;
    case "error":
      return <AlertCircle size={14} className="batch-status-icon error" aria-label="Error" />;
    default:
      return <FileAudio size={14} className="batch-status-icon pending" aria-label="Pending" />;
  }
}
