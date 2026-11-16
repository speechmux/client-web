"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileAudio, X, Download, Play, AlertCircle, CheckCircle, Loader } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { SpeechMuxWsClient, type SessionConfig } from "@/lib/speechmux-ws";
import { decodeAudioFileToPcm16, chunkInt16, TARGET_SAMPLE_RATE, MAX_FILE_BYTES } from "@/lib/audio-utils";
import { downloadTextFile, fileTimestamp } from "@/lib/browser";
import { formatBytes, pluralize, stripExtension } from "@/lib/format";
import { formatSrt, type SrtCue } from "@/lib/srt";

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
  /** One cue per final result, with session-relative timestamps — the source of the SRT export. */
  segments: SrtCue[];
  errorMessage: string | null;
  /** False when trying again cannot help (the file is over the size limit). */
  canRetry: boolean;
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

interface BatchPanelProps {
  wsUrl: string;
  sessionConfig: SessionConfig;
  /** Told whenever a batch run starts or stops, so the page can lock its settings meanwhile. */
  onRunningChange?: (isRunning: boolean) => void;
}

/**
 * A finished transcript, clamped to three lines. "Show more" is offered only when
 * the clamp actually hides something — a one-line result gets no dead toggle.
 */
function BatchTranscript({ text }: { text: string }): React.JSX.Element {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);

  useEffect(() => {
    const el = textRef.current;
    if (!el || isExpanded) return undefined;
    const measure = (): void => setIsTruncated(el.scrollHeight > el.clientHeight + 1);
    measure();
    // The width changes with the window, and with it the number of lines.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, isExpanded]);

  return (
    <>
      <p ref={textRef} className={`batch-transcript${isExpanded ? "" : " is-clamped"}`}>
        {text}
      </p>
      {(isTruncated || isExpanded) && (
        <button
          type="button"
          className="link-btn"
          onClick={() => setIsExpanded((prev) => !prev)}
          aria-expanded={isExpanded}
        >
          {isExpanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

export function BatchPanel({ wsUrl, sessionConfig, onRunningChange }: BatchPanelProps): React.JSX.Element {
  const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const cancelRef = useRef(false);
  const dragCountRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    onRunningChange?.(isRunning);
    return () => {
      if (isRunning) onRunningChange?.(false);
    };
  }, [isRunning, onRunningChange]);

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
        segments: [],
        errorMessage: tooLarge ? `File exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB limit.` : null,
        canRetry: !tooLarge,
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
  }, []);

  const updateFile = useCallback(
    (id: string, patch: Partial<Omit<BatchFile, "id" | "file">>) => {
      setBatchFiles((prev) =>
        prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
      );
    },
    []
  );

  /** Queue a failed file again; it runs with the next Start. */
  const retryFile = useCallback(
    (id: string) => {
      updateFile(id, { status: "pending", progress: 0, errorMessage: null });
    },
    [updateFile]
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
      if (isRunning) return;
      if (event.dataTransfer.files.length > 0) {
        addFiles(event.dataTransfer.files);
      }
    },
    [addFiles, isRunning]
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
        errorMessage: `Decode failed: ${decodeError instanceof Error ? decodeError.message : String(decodeError)}`,
      });
      return;
    }

    updateFile(entry.id, { progress: 10 });

    const collectedParts: string[] = [];
    const collectedSegments: SrtCue[] = [];
    let sessionEnded = false;

    const speechMuxClient = new SpeechMuxWsClient(wsUrl, sessionConfig, {
      onResult: (result) => {
        // Engines differ on leading whitespace; trim so joined text has single spaces.
        const text = result.committedText.trim();
        if (result.isFinal && text) {
          collectedParts.push(text);
          collectedSegments.push({ startSec: result.startSec, endSec: result.endSec, text });
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
        errorMessage: `Connection failed: ${connectError instanceof Error ? connectError.message : String(connectError)}`,
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
      if (cancelRef.current) {
        // Cancel also covers files that are only waiting for their result; without
        // this they would hold a session open until the timeout.
        speechMuxClient.close();
        updateFile(entry.id, { status: "pending", progress: 0 });
        return;
      }
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

    const finalTranscript = collectedParts.join(" ");
    updateFile(entry.id, {
      status: "done",
      progress: 100,
      transcript: finalTranscript,
      segments: collectedSegments,
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
          // Files still queued behind the semaphore when Cancel is pressed stay pending.
          if (!cancelRef.current) await processFile(entry);
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
        segments: entry.segments.map((segment) => ({
          start_sec: segment.startSec,
          end_sec: segment.endSec,
          text: segment.text,
        })),
      }));
    downloadTextFile(
      `speechmux-batch-${fileTimestamp()}.json`,
      JSON.stringify(data, null, 2),
      "application/json",
    );
  }, [batchFiles]);

  const downloadTxt = useCallback(() => {
    const done = batchFiles.filter((entry) => entry.status === "done");
    // One file: just its transcript. Several: a "# name" heading before each.
    const text =
      done.length === 1
        ? `${done[0]!.transcript}\n`
        : done.map((entry) => `# ${entry.file.name}\n${entry.transcript}\n`).join("\n");
    downloadTextFile(`speechmux-batch-${fileTimestamp()}.txt`, text, "text/plain;charset=utf-8");
  }, [batchFiles]);

  /** SRT is per media file, like `speechmux batch --srt`: `<name>.srt` next to `<name>.wav`. */
  const downloadSrt = useCallback((entry: BatchFile) => {
    downloadTextFile(
      `${stripExtension(entry.file.name)}.srt`,
      formatSrt(entry.segments),
      "application/x-subrip;charset=utf-8",
    );
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  const pendingCount = batchFiles.filter((entry) => entry.status === "pending").length;
  const doneCount = batchFiles.filter((entry) => entry.status === "done").length;
  const errorCount = batchFiles.filter((entry) => entry.status === "error").length;

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
              Start ({pluralize(pendingCount, "file")})
            </button>
          ) : (
            <button type="button" className="btn-small danger" onClick={cancelBatch}>
              Cancel
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

      {/* Progress summary + export */}
      {batchFiles.length > 0 && (
        <div className="batch-summary">
          <p className="muted" role="status">
            {doneCount} of {batchFiles.length} done
            {errorCount > 0 && <span className="batch-summary-failed"> · {errorCount} failed</span>}
          </p>
          {doneCount > 0 && (
            <div className="batch-export" role="group" aria-label="Export finished transcripts">
              <Download size={14} className="muted" aria-hidden="true" />
              <button type="button" className="btn-small" onClick={downloadJson}>JSON</button>
              <button type="button" className="btn-small" onClick={downloadTxt}>TXT</button>
            </div>
          )}
        </div>
      )}

      {/* File list */}
      {batchFiles.length > 0 && (
        <ul className="batch-file-list">
          {batchFiles.map((entry) => (
            <li key={entry.id} className={`batch-file is-${entry.status}`}>
              <div className="batch-file-row">
                <StatusIcon status={entry.status} />
                <span className="batch-file-name" title={entry.file.name}>{entry.file.name}</span>
                <span className="batch-file-size">{formatBytes(entry.file.size)}</span>
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
                  aria-label={`Progress for ${entry.file.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={entry.progress}
                >
                  <div className="batch-progress-bar" style={{ width: `${entry.progress}%` }} />
                </div>
              )}

              {entry.status === "done" && entry.transcript && (
                <div className="batch-file-actions">
                  <BatchTranscript text={entry.transcript} />
                  <CopyButton className="link-btn" label="Copy" getText={() => entry.transcript} />
                  <button type="button" className="link-btn" onClick={() => downloadSrt(entry)}>
                    Download SRT
                  </button>
                </div>
              )}

              {entry.status === "done" && !entry.transcript && (
                <p className="batch-transcript muted">(no speech detected)</p>
              )}

              {entry.status === "error" && entry.errorMessage && (
                <p className="batch-error">{entry.errorMessage}</p>
              )}

              {entry.status === "error" && entry.canRetry && !isRunning && (
                <div className="batch-file-actions">
                  <button type="button" className="link-btn" onClick={() => retryFile(entry.id)}>
                    Retry
                  </button>
                </div>
              )}
            </li>
          ))}
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
