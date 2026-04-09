"use client";

import { useCallback, useRef, useState } from "react";
import { FileAudio, X, Download, Play, AlertCircle, CheckCircle, Loader } from "lucide-react";
import { SpeechMuxWsClient, type SessionConfig } from "@/lib/speechmux-ws";
import { decodeAudioFileToPcm16, chunkInt16, TARGET_SAMPLE_RATE } from "@/lib/audio-utils";

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

interface BatchPanelProps {
  wsUrl: string;
  sessionConfig: SessionConfig;
}

export function BatchPanel({ wsUrl, sessionConfig }: BatchPanelProps): React.JSX.Element {
  const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const cancelRef = useRef(false);
  const dragCountRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  // ── File list management ──────────────────────────────────────────────────

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const newEntries: BatchFile[] = [];
    for (const file of incoming) {
      const id = fileId(file);
      newEntries.push({
        id,
        file,
        status: "pending",
        progress: 0,
        transcript: "",
        errorMessage: null,
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
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          isDragging
            ? "border-blue-400 bg-blue-50 dark:bg-blue-950"
            : "border-gray-300 dark:border-gray-700 hover:border-gray-400"
        }`}
      >
        <FileAudio className="mx-auto mb-2 text-gray-400" size={28} />
        <p className="text-sm text-gray-500 mb-2">
          Drag and drop audio files here, or{" "}
          <label className="text-blue-600 dark:text-blue-400 cursor-pointer hover:underline">
            browse
            <input
              type="file"
              accept="audio/*"
              multiple
              onChange={handleFileInputChange}
              disabled={isRunning}
              className="hidden"
            />
          </label>
        </p>
        <p className="text-xs text-gray-400">WAV, FLAC, MP3 — max 100 MB per file</p>
      </div>

      {/* Controls */}
      {batchFiles.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="concurrency" className="text-gray-500 text-xs">
              Parallel sessions
            </label>
            <select
              id="concurrency"
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))}
              disabled={isRunning}
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-0.5 text-sm"
            >
              {[1, 2, 4, 8].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </div>

          {!isRunning ? (
            <button
              onClick={startBatch}
              disabled={pendingCount === 0}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-40"
            >
              <Play size={14} />
              Start ({pendingCount} files)
            </button>
          ) : (
            <button
              onClick={cancelBatch}
              className="flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
          )}

          {doneCount > 0 && (
            <button
              onClick={downloadJson}
              className="flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900 px-3 py-1.5 text-sm font-medium transition-colors"
            >
              <Download size={14} />
              Download JSON ({doneCount})
            </button>
          )}

          <button
            onClick={clearAll}
            disabled={isRunning}
            className="ml-auto text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40"
          >
            Clear all
          </button>
        </div>
      )}

      {/* File list */}
      {batchFiles.length > 0 && (
        <ul className="space-y-2">
          {batchFiles.map((entry) => (
            <li
              key={entry.id}
              className="rounded-lg border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <StatusIcon status={entry.status} />
                <span className="flex-1 truncate font-medium text-xs">{entry.file.name}</span>
                <span className="text-xs text-gray-400">
                  {(entry.file.size / 1024).toFixed(0)} KB
                </span>
                {!isRunning && (
                  <button
                    onClick={() => removeFile(entry.id)}
                    className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    aria-label={`Remove ${entry.file.name}`}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {/* Progress bar */}
              {entry.status === "processing" && (
                <div className="mt-1.5 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${entry.progress}%` }}
                  />
                </div>
              )}

              {/* Transcript */}
              {entry.status === "done" && entry.transcript && (
                <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-400 leading-relaxed line-clamp-3">
                  {entry.transcript}
                </p>
              )}

              {/* Error */}
              {entry.status === "error" && entry.errorMessage && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {entry.errorMessage}
                </p>
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
      return <Loader size={14} className="text-blue-500 animate-spin flex-shrink-0" />;
    case "done":
      return <CheckCircle size={14} className="text-green-500 flex-shrink-0" />;
    case "error":
      return <AlertCircle size={14} className="text-red-500 flex-shrink-0" />;
    default:
      return <FileAudio size={14} className="text-gray-400 flex-shrink-0" />;
  }
}
