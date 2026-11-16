"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Info, Loader, Mic, Square, Upload } from "lucide-react";
import { formatClock } from "@/lib/format";

/**
 * Where the live session is:
 *  - "idle": nothing running; the action starts a session.
 *  - "connecting": Start was pressed; the server has not confirmed the session yet.
 *  - "permission": the session is confirmed; waiting for the browser to hand over the microphone.
 *  - "live": audio is being captured (mic) or sent (file).
 *  - "reconnecting": the connection dropped and the client is retrying.
 *  - "finishing": Stop was pressed; waiting for the server's last results.
 */
export type SessionPhase = "idle" | "connecting" | "permission" | "live" | "reconnecting" | "finishing";

interface SessionDockProps {
  phase: SessionPhase;
  mode: "mic" | "file";
  /** Why a session cannot be started right now; null when it can. Only shown while idle. */
  blockedReason: string | null;
  /** Date.now() at the moment capture began; null while nothing is being captured. */
  startedAt: number | null;
  /** Microphone level 0–1. */
  micLevel: number;
  /** Share of the file already sent, 0–1. */
  uploadProgress: number;
  onStart: () => void;
  onStop: () => void;
}

/**
 * Presses closer together than this are treated as one. Start and Stop share a
 * button, so without it a double-click would start a session and cancel it again.
 */
const TOGGLE_GUARD_MS = 350;

/** Ticking elapsed-time readout. Owns its timer so the page does not re-render every tick. */
function ElapsedClock({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [startedAt]);

  return (
    <span className="dock-clock" role="timer" aria-label="Elapsed time">
      {formatClock(now - startedAt)}
    </span>
  );
}

/**
 * Bottom action bar: one Start/Stop button plus, while a session runs, what it is
 * doing — elapsed time with the mic level or the upload progress.
 */
export function SessionDock({
  phase,
  mode,
  blockedReason,
  startedAt,
  micLevel,
  uploadProgress,
  onStart,
  onStop,
}: SessionDockProps): React.JSX.Element {
  const lastToggleRef = useRef(0);
  const isStoppable = phase !== "idle" && phase !== "finishing";
  const isBlocked = phase === "idle" && blockedReason !== null;

  const handleClick = useCallback(() => {
    const now = performance.now();
    if (now - lastToggleRef.current < TOGGLE_GUARD_MS) return;
    lastToggleRef.current = now;
    if (isStoppable) onStop();
    else onStart();
  }, [isStoppable, onStart, onStop]);

  let info: React.JSX.Element | null = null;
  if (phase === "live" && startedAt !== null) {
    const percent = Math.round(uploadProgress * 100);
    info =
      mode === "mic" ? (
        <>
          <span className="rec-dot" aria-hidden="true" />
          <ElapsedClock startedAt={startedAt} />
          <span className="meter" aria-hidden="true">
            <span className="meter-fill" style={{ transform: `scaleX(${micLevel})` }} />
          </span>
          <span className="sr-only">Recording</span>
        </>
      ) : uploadProgress >= 1 ? (
        <>
          <Loader size={16} className="spin" aria-hidden="true" />
          <span>Waiting for results…</span>
        </>
      ) : (
        <>
          <ElapsedClock startedAt={startedAt} />
          <span
            className="meter"
            role="progressbar"
            aria-label="File sent"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className="meter-fill is-progress" style={{ transform: `scaleX(${uploadProgress})` }} />
          </span>
          <span className="dock-percent">{percent}%</span>
        </>
      );
  } else if (phase === "connecting") {
    info = (
      <>
        <Loader size={16} className="spin" aria-hidden="true" />
        <span>Connecting…</span>
      </>
    );
  } else if (phase === "permission") {
    info = (
      <>
        <Mic size={16} aria-hidden="true" />
        <span>Waiting for microphone…</span>
      </>
    );
  } else if (phase === "reconnecting") {
    info = (
      <>
        <Loader size={16} className="spin" aria-hidden="true" />
        <span>Reconnecting…</span>
      </>
    );
  } else if (isBlocked) {
    info = (
      <>
        <Info size={16} aria-hidden="true" />
        <span>{blockedReason}</span>
      </>
    );
  }

  const StartIcon = mode === "mic" ? Mic : Upload;

  return (
    <footer className="dock">
      <div className="dock-inner">
        {info && (
          <div className={`dock-info${isBlocked ? " is-hint" : ""}`} role={isBlocked ? "note" : undefined}>
            {info}
          </div>
        )}
        <button
          type="button"
          className={`dock-action ${isStoppable ? "btn-danger" : "btn-primary"}`}
          onClick={handleClick}
          disabled={phase === "finishing" || isBlocked}
          aria-keyshortcuts="Space"
        >
          {phase === "finishing" ? (
            <>
              <Loader size={18} className="spin" aria-hidden="true" />
              Finishing…
            </>
          ) : isStoppable ? (
            <>
              <Square size={16} fill="currentColor" aria-hidden="true" />
              Stop
              <kbd aria-hidden="true">Space</kbd>
            </>
          ) : (
            <>
              <StartIcon size={18} aria-hidden="true" />
              {mode === "mic" ? "Start" : "Send file"}
              {!isBlocked && <kbd aria-hidden="true">Space</kbd>}
            </>
          )}
        </button>
      </div>
    </footer>
  );
}
