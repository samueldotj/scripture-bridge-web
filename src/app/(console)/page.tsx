import Link from 'next/link';
import { dashboardStats, listAudit, listProjects } from '@/lib/queries';
import { Progress, Timestamp } from '@/components/display';

export default async function OverviewPage() {
  const [stats, projects, recent] = await Promise.all([
    dashboardStats(),
    listProjects(),
    listAudit({ limit: 8, offset: 0 }),
  ]);

  return (
    <>
      <div className="page-head">
        <h1>Overview</h1>
        <p>
          Provisioning and workflow administration for the Scripture Bridge backend. The Android
          app has no administrative UI, so accounts, projects, memberships, assignments, and
          chapter reopening exist only here.
        </p>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="value">{stats?.project_count ?? 0}</div>
          <div className="label">Active projects</div>
        </div>
        <div className="stat">
          <div className="value">{stats?.account_count ?? 0}</div>
          <div className="label">Accounts</div>
        </div>
        <div className={stats?.accounts_pending_password ? 'stat attention' : 'stat'}>
          <div className="value">{stats?.accounts_pending_password ?? 0}</div>
          <div className="label">Awaiting first password change</div>
        </div>
        <div className="stat">
          <div className="value">{stats?.chapters_in_review ?? 0}</div>
          <div className="label">Chapters in review</div>
        </div>
        <div className={stats?.chapters_flagged ? 'stat attention' : 'stat'}>
          <div className="value">{stats?.chapters_flagged ?? 0}</div>
          <div className="label">Chapters with flagged verses</div>
        </div>
        <div className={stats?.unassigned_chapters ? 'stat attention' : 'stat'}>
          <div className="value">{stats?.unassigned_chapters ?? 0}</div>
          <div className="label">Unassigned chapters</div>
        </div>
      </div>

      <section className="card">
        <h2>Projects</h2>
        <p className="hint">Verse progress is read from maintained counters, not recomputed.</p>
        {projects.length === 0 ? (
          <p className="empty">
            No projects yet. <Link href="/projects/new">Create the first one</Link>.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Language</th>
                  <th className="num">Books</th>
                  <th className="num">Members</th>
                  <th>Verses done</th>
                  <th className="num">Approved</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/projects/${p.id}`}>{p.name}</Link>
                    </td>
                    <td>
                      {p.language_name}{' '}
                      <span className="muted mono">
                        {p.language_code}/{p.script_code}
                      </span>
                    </td>
                    <td className="num">{p.book_count}</td>
                    <td className="num">{p.member_count}</td>
                    <td>
                      <Progress done={p.verses_done} total={p.verse_count} />
                    </td>
                    <td className="num">
                      {p.chapters_approved} / {p.chapter_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Recent privileged actions</h2>
        <p className="hint">
          Every service-key operation is recorded with the operator who performed it. The log is
          append-only — nothing here can be edited or removed.
        </p>
        {recent.length === 0 ? (
          <p className="empty">Nothing recorded yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Operator</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Timestamp value={a.occurred_at} />
                    </td>
                    <td className="mono">{a.action}</td>
                    <td>
                      {a.actor_label ?? a.actor_name ?? (
                        <span className="muted">{a.actor_kind}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ marginTop: 12, marginBottom: 0 }}>
          <Link href="/audit">Full audit log →</Link>
        </p>
      </section>
    </>
  );
}
