"use client";

import { useEffect, useRef } from "react";
import type { RecognitionResult } from "@/lib/speechmux-ws";

export interface TranscriptLine {
  id: string;
  /** Pre-computed incremental text (relative to previous final result). */
  displayText: string;
  unstableText: string;
  languageCode: string;
  startSec: number;
  endSec: number;
  isFinal: boolean;
}

interface TranscriptViewProps {
  lines: TranscriptLine[];
}

/** Maximum number of lines to render before pruning old entries. */
const MAX_LINES = 500;

/**
 * Extract the incremental portion of currentText beyond the baseline.
 * Used at result-processing time, not at render time, so baselineText
 * changes do not retroactively affect already-displayed lines.
 */
export function extractIncremental(currentText: string, baselineText: string): string {
  const current = currentText.trim();
  const baseline = baselineText.trim();
  if (!current) return "";
  if (!baseline) return current;
  if (current.startsWith(baseline)) {
    return current.slice(baseline.length).trimStart();
  }
  const baselineNoPunct = baseline.replace(/[\s.,!?;:]+$/, "").trim();
  if (baselineNoPunct && current.startsWith(baselineNoPunct)) {
    return current.slice(baselineNoPunct.length).trimStart();
  }
  const currentLower = current.toLowerCase();
  const baselineLower = baseline.toLowerCase();
  if (baselineLower && currentLower.startsWith(baselineLower)) {
    return current.slice(baseline.length).trimStart();
  }
  const index = current.indexOf(baseline);
  if (index >= 0) {
    return current.slice(index + baseline.length).trimStart();
  }
  return current;
}

export function TranscriptView({ lines }: TranscriptViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [lines.length]);

  const visibleLines = lines.slice(-MAX_LINES);

  if (visibleLines.length === 0) {
    return (
      <div className="transcript-list">
        <p className="muted">Results will appear here.</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="transcript-list"
      aria-live="polite"
      aria-label="Transcription results"
    >
      {[...visibleLines].reverse().map((line) => {
        if (!line.displayText && !line.unstableText) return null;
        return (
          <div
            key={line.id}
            className={`line ${line.isFinal ? "final" : "partial"}`}
          >
            <p>
              {line.displayText && <span>{line.displayText}</span>}
              {!line.isFinal && line.unstableText && (
                <span className="unstable">{" "}{line.unstableText}</span>
              )}
            </p>
            <small className="meta">
              <span className="lang-pill">{(line.languageCode || "auto").toUpperCase()}</span>
              <span className="time-range">
                {line.startSec.toFixed(2)}s – {line.endSec.toFixed(2)}s
              </span>
            </small>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Promote the last partial line to final when the session ends.
 */
export function applyDone(lines: TranscriptLine[]): TranscriptLine[] {
  const lastLine = lines[lines.length - 1];
  if (!lastLine || lastLine.isFinal) return lines;
  return [
    ...lines.slice(0, -1),
    { ...lastLine, isFinal: true, unstableText: "" },
  ];
}

/**
 * Build a new lines array from an incoming recognition result.
 * displayText is computed here at result time using the current baseline,
 * so it is immune to future baseline changes.
 */
export function applyResult(
  lines: TranscriptLine[],
  result: RecognitionResult,
  baselineText: string,
): TranscriptLine[] {
  const lastLine = lines[lines.length - 1];

  if (result.isFinal) {
    const sourceText = result.committedText || result.text;
    const displayText = extractIncremental(sourceText, baselineText);

    if (lastLine && !lastLine.isFinal) {
      // Promote existing partial line to final.
      return [
        ...lines.slice(0, -1),
        {
          ...lastLine,
          displayText,
          unstableText: "",
          isFinal: true,
          languageCode: result.languageCode,
          endSec: result.endSec,
        },
      ];
    }

    // No partial to promote. Only add a new line if there's actual new content.
    // An empty displayText here means the committed text was already covered by
    // the baseline (duplicate final from the server), so we skip it.
    if (!displayText) return lines;

    const newLines = [
      ...lines,
      {
        id: `${Date.now()}-${Math.random()}`,
        displayText,
        unstableText: "",
        isFinal: true,
        languageCode: result.languageCode,
        startSec: result.startSec,
        endSec: result.endSec,
      },
    ];
    // Cap the state array so React's diffing cost stays bounded during long
    // sessions. The render already slices to MAX_LINES; cap at MAX_LINES + 1
    // to allow for one in-progress partial on top of MAX_LINES finals.
    return newLines.length > MAX_LINES + 1 ? newLines.slice(-(MAX_LINES + 1)) : newLines;
  }

  // Partial result — update or create the live line.
  const partialLine: TranscriptLine = {
    id: lastLine && !lastLine.isFinal ? lastLine.id : `${Date.now()}-${Math.random()}`,
    displayText: extractIncremental(result.committedText, baselineText),
    unstableText: result.unstableText,
    isFinal: false,
    languageCode: result.languageCode,
    startSec: result.startSec,
    endSec: result.endSec,
  };

  if (lastLine && !lastLine.isFinal) {
    return [...lines.slice(0, -1), partialLine];
  }
  return [...lines, partialLine];
}
