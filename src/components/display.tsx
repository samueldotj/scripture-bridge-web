import type { WorkflowState } from '@/lib/queries';

const STATE_LABELS: Record<WorkflowState, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  in_review: 'In review',
  approved: 'Approved',
};

export function StateBadge({ state }: { state: WorkflowState }) {
  return <span className={`badge ${state}`}>{STATE_LABELS[state]}</span>;
}

export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <div className="bar" role="img" aria-label={`${pct}% of verses done`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="bar-label nowrap">
        {done.toLocaleString()} / {total.toLocaleString()}
      </span>
    </div>
  );
}

/**
 * A person, as the console can know them.
 *
 * Erasure drops `auth_user_id` to null and clears the display name (DB
 * R-DATA-4), so a member row can legitimately have neither. Falling back to the
 * profile id keeps the row identifiable and the assignment revocable, which is
 * the operator's actual need.
 */
export function Person({
  name,
  email,
  id,
}: {
  name: string | null;
  email?: string | null;
  id?: string;
}) {
  if (name) {
    return (
      <>
        {name}
        {email ? <div className="muted mono">{email}</div> : null}
      </>
    );
  }
  if (email) return <span className="mono">{email}</span>;
  return <span className="muted">erased · {id ? id.slice(0, 8) : 'unknown'}</span>;
}

/** Server-rendered timestamps are formatted in UTC so two operators see the same string. */
export function Timestamp({ value }: { value: string | Date | null }) {
  if (!value) return <span className="muted">—</span>;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return <span className="muted">—</span>;
  return (
    <span className="nowrap" title={d.toISOString()}>
      {d.toISOString().slice(0, 16).replace('T', ' ')}Z
    </span>
  );
}
