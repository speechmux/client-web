/** Browser side effects shared across components: clipboard and file download. */

/**
 * Copy text to the clipboard and resolve to whether it got there.
 *
 * The async Clipboard API only exists in secure contexts; on a plain-HTTP LAN origin
 * it is undefined, so fall back to a hidden textarea and `execCommand("copy")`.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or document not focused — try the legacy path below.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

/** Offer `content` to the user as a file download named `fileName`. */
export function downloadTextFile(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}

/** A file-name-safe UTC timestamp, e.g. `2026-11-17T01-45-10`. */
export function fileTimestamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace(/:/g, "-");
}
