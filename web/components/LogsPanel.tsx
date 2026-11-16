import { memo } from "react";
import { ChevronRight } from "lucide-react";
import { pluralize } from "@/lib/format";

export interface LogEntry {
  id: string;
  text: string;
  level: "info" | "warn" | "error";
}

interface LogsPanelProps {
  /** Newest first. */
  logs: LogEntry[];
  onClear: () => void;
}

/**
 * Client log, collapsed by default so it does not compete with the transcript.
 * The summary line still says how many entries there are and whether any are
 * warnings or errors, so problems are noticeable without opening it.
 */
export const LogsPanel = memo(function LogsPanel({ logs, onClear }: LogsPanelProps): React.JSX.Element {
  const errorCount = logs.filter((entry) => entry.level === "error").length;
  const warnCount = logs.filter((entry) => entry.level === "warn").length;

  return (
    <details className="card logs">
      <summary>
        <ChevronRight size={16} className="disclosure-icon" aria-hidden="true" />
        <span className="summary-title">Logs</span>
        <span className="count-pill">{logs.length}</span>
        {errorCount > 0 && (
          <span className="count-pill" data-state="error">{pluralize(errorCount, "error")}</span>
        )}
        {warnCount > 0 && (
          <span className="count-pill" data-state="warn">{pluralize(warnCount, "warning")}</span>
        )}
      </summary>
      <div className="logs-body">
        {logs.length === 0 ? (
          <p className="muted logs-empty">Connection and session events will be listed here.</p>
        ) : (
          <>
            <div className="log-list">
              {logs.map((entry) => (
                <div key={entry.id} className={`log${entry.level !== "info" ? ` ${entry.level}` : ""}`}>
                  {entry.text}
                </div>
              ))}
            </div>
            <button type="button" className="ghost" onClick={onClear}>
              Clear logs
            </button>
          </>
        )}
      </div>
    </details>
  );
});
