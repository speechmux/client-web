"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, AudioLines } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { MAX_LINES, type TranscriptLine } from "@/lib/transcript";

const LANG_NAMES: Record<string, string> = {
  ko: "Korean", en: "English", ja: "Japanese", zh: "Chinese",
  fr: "French", de: "German", es: "Spanish", pt: "Portuguese",
  ru: "Russian", ar: "Arabic", hi: "Hindi",
};

function langDisplayName(code: string): string {
  return LANG_NAMES[code.toLowerCase()] ?? code.toUpperCase();
}

interface TranscriptViewProps {
  lines: TranscriptLine[];
  showWallTime: boolean;
  /** Headline shown while there are no lines, e.g. "No transcript yet" or "Listening…". */
  emptyTitle: string;
  /** Second line of the empty state: what to do next, or what is being waited for. */
  emptyHint: string;
  /** True while a session is in progress: the empty state animates and is announced. */
  isBusy: boolean;
}

/** Distance (px) from the bottom within which the view counts as "pinned" to the latest line. */
const PIN_THRESHOLD_PX = 24;

export const TranscriptView = memo(function TranscriptView({
  lines,
  showWallTime,
  emptyTitle,
  emptyHint,
  isBusy,
}: TranscriptViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  // Lines render oldest → newest. The view follows the newest line only while the
  // user is at (or near) the bottom; scrolling up to read earlier text pauses that.
  const pinnedRef = useRef(true);
  const [isPinned, setIsPinned] = useState(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
    pinnedRef.current = pinned;
    setIsPinned(pinned);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setIsPinned(true);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      // Nothing is rendered (transcript cleared): the next line starts pinned again.
      pinnedRef.current = true;
      setIsPinned(true);
      return;
    }
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  const visibleLines = lines
    .slice(-MAX_LINES)
    .filter((line) => line.displayText || line.unstableText);

  // Screen readers get each finished utterance once, from a separate live region.
  // Making the visible list live would re-announce the line on every partial update.
  let latestFinalText = "";
  for (let index = visibleLines.length - 1; index >= 0; index--) {
    const candidate = visibleLines[index]!;
    if (candidate.isFinal && candidate.displayText) {
      latestFinalText = candidate.displayText;
      break;
    }
  }

  if (visibleLines.length === 0) {
    return (
      <div className="transcript-list is-empty">
        <div className={`empty-state${isBusy ? " is-busy" : ""}`}>
          <AudioLines size={28} className="empty-state-icon" aria-hidden="true" />
          <strong role={isBusy ? "status" : undefined}>{emptyTitle}</strong>
          <p>{emptyHint}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript-wrap">
      <div
        ref={containerRef}
        className="transcript-list"
        aria-label="Transcription results"
        onScroll={handleScroll}
      >
        {visibleLines.map((line) => (
          <div key={line.id} className={`line ${line.isFinal ? "final" : "partial"}`}>
            <div className="line-body">
              <p lang={line.languageCode || undefined}>
                {line.displayText && <span>{line.displayText}</span>}
                {!line.isFinal && line.unstableText && (
                  <span className="unstable">{" "}{line.unstableText}</span>
                )}
              </p>
              {line.isFinal && (
                <CopyButton
                  className="copy-line-btn"
                  label="Copy line"
                  iconOnly
                  getText={() => line.displayText}
                />
              )}
            </div>
            <small className="meta">
              <span
                className="lang-pill"
                title={line.languageCode ? langDisplayName(line.languageCode) : "Auto-detected"}
              >{(line.languageCode || "auto").toUpperCase()}</span>
              <span className="engine-pill">{line.engineName}</span>
              <span className="time-range">
                {showWallTime
                  ? new Date(line.wallTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                  : `${line.startSec.toFixed(2)}s – ${line.endSec.toFixed(2)}s`}
              </span>
              {!line.isFinal && <span className="live-pill">Live</span>}
            </small>
          </div>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">{latestFinalText}</p>
      {!isPinned && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          <ArrowDown size={14} aria-hidden="true" />
          Jump to latest
        </button>
      )}
    </div>
  );
});
