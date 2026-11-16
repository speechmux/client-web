/**
 * SRT subtitle formatting.
 *
 * Mirrors client-cli's `speechmux_cli/commands/_srt.py` so a file transcribed in the
 * browser and through the CLI yields the same subtitle file.
 */

export interface SrtCue {
  /** Start time in seconds. */
  startSec: number;
  /** End time in seconds. When not after startSec, a 1-second cue is assumed. */
  endSec: number;
  text: string;
}

/** Convert seconds to the SRT timestamp format `HH:MM:SS,mmm` (milliseconds truncated, like the CLI). */
export function toSrtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.trunc(seconds * 1000));
  const millis = totalMs % 1000;
  const totalSec = Math.trunc(totalMs / 1000);
  const hours = Math.trunc(totalSec / 3600);
  const minutes = Math.trunc((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(millis, 3)}`;
}

/**
 * Render cues as an SRT document.
 *
 * Cues with blank text are dropped and the remaining ones are numbered from 1.
 * Returns an empty string when nothing is left.
 */
export function formatSrt(cues: readonly SrtCue[]): string {
  let output = "";
  let index = 0;
  for (const cue of cues) {
    const text = cue.text.trim();
    if (!text) continue;
    index += 1;
    const endSec = cue.endSec <= cue.startSec ? cue.startSec + 1 : cue.endSec;
    output += `${index}\n${toSrtTimestamp(cue.startSec)} --> ${toSrtTimestamp(endSec)}\n${text}\n\n`;
  }
  return output;
}
