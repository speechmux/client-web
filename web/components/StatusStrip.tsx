import { Circle, CircleCheck, CircleDot, CircleX, TriangleAlert, type LucideIcon } from "lucide-react";

export type StatusKind = "idle" | "ok" | "active" | "warn" | "error";

export interface StatusEntry {
  text: string;
  kind: StatusKind;
}

export interface StatusItem {
  label: string;
  status: StatusEntry;
}

/**
 * One icon shape per state, so a state is recognisable without relying on colour:
 * hollow ring (idle), ringed dot (active), check (ok), triangle (warn), cross (error).
 */
const KIND_ICON: Record<StatusKind, LucideIcon> = {
  idle: Circle,
  active: CircleDot,
  ok: CircleCheck,
  warn: TriangleAlert,
  error: CircleX,
};

/** Compact row of session states: connection, capture, transfer and result. */
export function StatusStrip({ items }: { items: readonly StatusItem[] }): React.JSX.Element {
  return (
    <section className="card status-strip" aria-label="Session status">
      <dl>
        {items.map(({ label, status }) => {
          const Icon = KIND_ICON[status.kind];
          return (
            <div key={label} className="status-item">
              <dt>{label}</dt>
              <dd data-state={status.kind}>
                <Icon size={14} className="status-icon" aria-hidden="true" />
                <span>{status.text}</span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
