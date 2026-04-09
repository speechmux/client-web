"use client";

import type { ConnectionState } from "@/lib/speechmux-ws";

interface StatusBarProps {
  connectionState: ConnectionState;
  errorMessage: string | null;
}

const STATE_LABELS: Record<ConnectionState, string> = {
  idle: "Idle",
  connecting: "Connecting…",
  ready: "Ready",
  reconnecting: "Reconnecting…",
  error: "Error",
  done: "Done",
};

const STATE_COLORS: Record<ConnectionState, string> = {
  idle: "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  connecting: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 animate-pulse",
  ready: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  reconnecting: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300 animate-pulse",
  error: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  done: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export function StatusBar({ connectionState, errorMessage }: StatusBarProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span
        className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATE_COLORS[connectionState]}`}
        aria-live="polite"
      >
        {STATE_LABELS[connectionState]}
      </span>
      {errorMessage && (
        <span className="text-red-600 dark:text-red-400 text-xs" role="alert">
          {errorMessage}
        </span>
      )}
    </div>
  );
}
