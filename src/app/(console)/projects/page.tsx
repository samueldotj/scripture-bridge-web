import Link from 'next/link';
import { listProjects } from '@/lib/queries';
import { Progress } from '@/components/display';

export default async function ProjectsPage() {
  const projects = await listProjects();

  return (
    <>
      <div className="page-head">
        <h1>Projects</h1>
        <p>
          Creating a project materialises every chapter and every empty verse row of the books you
          choose, from the versification scheme. The scheme is fixed at creation and cannot be
          changed afterwards.
        </p>
      </div>

      <p className="actions-row" style={{ marginBottom: 18 }}>
        <Link href="/projects/new">
          <button className="primary small" type="button">
            New project
          </button>
        </Link>
      </p>

      <div className="card">
        {projects.length === 0 ? (
          <p className="empty">No projects yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Language</th>
                  <th>Scheme</th>
                  <th className="num">Books</th>
                  <th className="num">Chapters</th>
                  <th className="num">Members</th>
                  <th>Verses done</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/projects/${p.id}`}>{p.name}</Link>
                      {p.text_direction === 'rtl' ? (
                        <span className="badge" style={{ marginLeft: 8 }}>
                          RTL
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {p.language_name}{' '}
                      <span className="muted mono">
                        {p.language_code}/{p.script_code}
                      </span>
                    </td>
                    <td className="mono">{p.versification_scheme}</td>
                    <td className="num">{p.book_count}</td>
                    <td className="num">{p.chapter_count}</td>
                    <td className="num">{p.member_count}</td>
                    <td>
                      <Progress done={p.verses_done} total={p.verse_count} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
