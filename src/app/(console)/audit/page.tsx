import Link from 'next/link';
import { listAudit, listAuditActions } from '@/lib/queries';
import { Timestamp } from '@/components/display';

const PAGE_SIZE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; page?: string; target?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? '1') || 1);
  const action = params.action?.trim() || undefined;
  // A malformed uuid would make the query throw; the filter is simply ignored.
  const target = /^[0-9a-f-]{36}$/i.test(params.target ?? '') ? params.target : undefined;

  const [entries, actions] = await Promise.all([
    // One extra row, so "next page" is offered only when there is one.
    listAudit({
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
      action,
      targetId: target,
    }),
    listAuditActions(),
  ]);

  const hasMore = entries.length > PAGE_SIZE;
  const rows = entries.slice(0, PAGE_SIZE);

  const link = (p: number) => {
    const q = new URLSearchParams();
    if (action) q.set('action', action);
    if (target) q.set('target', target);
    if (p > 1) q.set('page', String(p));
    const s = q.toString();
    return s ? `/audit?${s}` : '/audit';
  };

  return (
    <>
      <div className="page-head">
        <h1>Audit log</h1>
        <p>
          Every privileged operation, with the operator who performed it and the before and after
          values. The table is append-only at the database level: no path through this console — or
          through any script holding the service key — can edit or delete an entry.
        </p>
      </div>

      <div className="card">
        <form className="row" style={{ marginBottom: 16 }}>
          <div className="field" style={{ flex: '0 0 260px' }}>
            <label htmlFor="action">Action</label>
            <select id="action" name="action" defaultValue={action ?? ''}>
              <option value="">All actions</option>
              {actions.map((a) => (
                <option key={a.action} value={a.action}>
                  {a.action}
                </option>
              ))}
            </select>
          </div>
          {target ? <input type="hidden" name="target" value={target} /> : null}
          <div className="field" style={{ flex: '0 0 auto' }}>
            <button type="submit" className="small">
              Filter
            </button>
          </div>
          {action || target ? (
            <div className="field" style={{ flex: '0 0 auto' }}>
              <Link href="/audit">Clear</Link>
            </div>
          ) : null}
        </form>

        {rows.length === 0 ? (
          <p className="empty">Nothing matches.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Operator</th>
                  <th>Target</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Timestamp value={e.occurred_at} />
                    </td>
                    <td className="mono">{e.action}</td>
                    <td>
                      {e.actor_label ?? e.actor_name ?? <span className="muted">{e.actor_kind}</span>}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {e.actor_kind}
                      </div>
                    </td>
                    <td>
                      <div>{e.target_type}</div>
                      {e.target_id ? (
                        <Link
                          className="mono"
                          href={`/audit?target=${e.target_id}`}
                          title="Show every entry for this target"
                        >
                          {e.target_id.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {e.before || e.after ? (
                        <details className="reveal">
                          <summary>before / after</summary>
                          <pre>
                            {JSON.stringify({ before: e.before, after: e.after }, null, 2)}
                          </pre>
                        </details>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="actions-row" style={{ marginTop: 16 }}>
          {page > 1 ? <Link href={link(page - 1)}>← Newer</Link> : null}
          {hasMore ? <Link href={link(page + 1)}>Older →</Link> : null}
          <span className="muted" style={{ fontSize: 13, marginLeft: 'auto' }}>
            Page {page}
          </span>
        </div>
      </div>
    </>
  );
}
