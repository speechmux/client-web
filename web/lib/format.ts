/** Small display formatters shared across components. */

/** Elapsed time as `m:ss`, or `h:mm:ss` from one hour on. Negative input counts as zero. */
export function formatClock(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

/** An audio length for prose: `5.6 s` under a minute, `2 min 5 s` above. */
export function formatDuration(seconds: number): string {
  const safe = Math.max(0, seconds);
  if (safe < 60) return `${safe.toFixed(1)} s`;
  const whole = Math.round(safe);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** A file size: `812 KB`, `3.4 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** `1 file` / `3 files` — count with the matching singular or plural noun. */
export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** File name without its last extension: `talk.final.wav` → `talk.final`. */
export function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
