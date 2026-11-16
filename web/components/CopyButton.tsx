"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { copyText } from "@/lib/browser";

/** How long the "Copied" confirmation stays before the button returns to its idle label. */
const FEEDBACK_MS = 1_600;

type CopyState = "idle" | "copied" | "failed";

interface CopyButtonProps {
  /** Produces the text to copy; evaluated when the button is pressed. */
  getText: () => string;
  /** Idle label, e.g. "Copy" — also the accessible name of an icon-only button. */
  label: string;
  className?: string;
  /** Render only the icon; the label is kept as the accessible name. */
  iconOnly?: boolean;
  disabled?: boolean;
  /** Called after each attempt with whether the text reached the clipboard. */
  onCopied?: (succeeded: boolean) => void;
}

/**
 * A copy-to-clipboard button that confirms the result in place, so the user does
 * not have to open the logs to learn whether the copy worked.
 */
export function CopyButton({
  getText,
  label,
  className,
  iconOnly = false,
  disabled = false,
  onCopied,
}: CopyButtonProps): React.JSX.Element {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const handleClick = useCallback(async () => {
    const succeeded = await copyText(getText());
    setState(succeeded ? "copied" : "failed");
    onCopied?.(succeeded);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setState("idle"), FEEDBACK_MS);
  }, [getText, onCopied]);

  const Icon = state === "copied" ? Check : state === "failed" ? X : Copy;
  const text = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;

  return (
    <button
      type="button"
      className={className}
      onClick={handleClick}
      disabled={disabled}
      data-copy-state={state}
      aria-label={iconOnly ? text : undefined}
    >
      <Icon size={14} aria-hidden="true" />
      {!iconOnly && <span className="btn-label">{text}</span>}
      <span className="sr-only" role="status">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Could not copy" : ""}
      </span>
    </button>
  );
}
