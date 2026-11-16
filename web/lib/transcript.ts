/**
 * Transcript line model and the pure functions that fold recognition results into it.
 *
 * Kept free of React so the merge logic can be unit-tested on its own.
 */

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
  /** engineHint used at session start, or "auto" when no hint was given. */
  engineName: string;
  /** Date.now() at the moment this line was created; used for wall-clock display in mic mode. */
  wallTime: number;
}

/** Maximum number of lines to render before pruning old entries. */
export const MAX_LINES = 500;

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
 * Keep the in-progress line when its server session is lost (connection dropped):
 * no final result will ever arrive for it, so promote it to final with everything
 * heard so far, unstable tail included. A line with no text at all is dropped.
 */
export function sealPartial(lines: TranscriptLine[]): TranscriptLine[] {
  const lastLine = lines[lines.length - 1];
  if (!lastLine || lastLine.isFinal) return lines;
  const text = [lastLine.displayText, lastLine.unstableText].filter(Boolean).join(" ");
  if (!text) return lines.slice(0, -1);
  return [
    ...lines.slice(0, -1),
    { ...lastLine, displayText: text, unstableText: "", isFinal: true },
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
  sessionEngineHint: string,
): TranscriptLine[] {
  const lastLine = lines[lines.length - 1];
  // Prefer the actual engine name reported by the server; fall back to the
  // session's engine hint (e.g. "auto") when the server hasn't sent one yet.
  const engineName = result.engineName || sessionEngineHint;

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
          engineName,
          wallTime: Date.now(),
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
        engineName,
        wallTime: Date.now(),
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
    engineName,
    wallTime: lastLine && !lastLine.isFinal ? lastLine.wallTime : Date.now(),
  };

  if (lastLine && !lastLine.isFinal) {
    return [...lines.slice(0, -1), partialLine];
  }
  return [...lines, partialLine];
}

/** Final lines that carry text, oldest first — what Copy and Download export. */
export function finalTextLines(lines: TranscriptLine[]): TranscriptLine[] {
  return lines.filter((line) => line.isFinal && line.displayText);
}

/** Plain-text export: one final line per row. */
export function transcriptToText(lines: TranscriptLine[]): string {
  return finalTextLines(lines)
    .map((line) => line.displayText)
    .join("\n");
}
