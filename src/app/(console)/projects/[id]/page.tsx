import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProject, listAccounts, listBooks, listMembers } from '@/lib/queries';
import { Progress } from '@/components/display';
import { MembersCard } from './members';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const project = await getProject(id);
  if (!project) notFound();

  const [books, members, accounts] = await Promise.all([
    listBooks(id),
    listMembers(id),
    listAccounts(),
  ]);

  return (
    <>
      <p className="breadcrumb">
        <Link href="/projects">Projects</Link> / {project.name}
      </p>
      <div className="page-head">
        <h1>{project.name}</h1>
      </div>

      <div className="card">
        <dl className="dl">
          <dt>Language</dt>
          <dd>
            {project.language_name} <span className="muted mono">{project.language_code}</span>
          </dd>
          <dt>Script</dt>
          <dd className="mono">{project.script_code}</dd>
          <dt>Direction</dt>
          <dd>{project.text_direction === 'rtl' ? 'Right to left' : 'Left to right'}</dd>
          <dt>Versification</dt>
          <dd className="mono">{project.versification_scheme}</dd>
          <dt>Project id</dt>
          <dd className="mono">{project.id}</dd>
        </dl>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="value">{project.chapters_approved}</div>
          <div className="label">Chapters approved</div>
        </div>
        <div className="stat">
          <div className="value">{project.chapters_in_review}</div>
          <div className="label">In review</div>
        </div>
        <div className="stat">
          <div className="value">{project.chapters_in_progress}</div>
          <div className="label">In progress</div>
        </div>
        <div className="stat">
          <div className="value">{project.chapters_not_started}</div>
          <div className="label">Not started</div>
        </div>
        <div className={project.verses_flagged ? 'stat attention' : 'stat'}>
          <div className="value">{project.verses_flagged}</div>
          <div className="label">Flagged verses</div>
        </div>
      </div>

      <section className="card">
        <h2>Export</h2>
        <p className="hint">
          Downloads every book of this project as one zip of USFM files, in canonical order. The
          files carry verse text only: paragraphs, headings, poetry, and footnotes are not stored
          by the app and must be re-marked by whoever receives them.
        </p>
        <div className="actions-row">
          <a className="btn primary" href={`/projects/${project.id}/export`} download>
            Export all {project.book_count} book{project.book_count === 1 ? '' : 's'} as USFM
          </a>
          {project.verse_count - project.verses_done > 0 ? (
            <span className="muted" style={{ fontSize: 13 }}>
              {(project.verse_count - project.verses_done).toLocaleString()} of{' '}
              {project.verse_count.toLocaleString()} verses are not yet marked done — they export
              as empty verse markers.
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>
              Every verse is marked done.
            </span>
          )}
        </div>
      </section>

      <MembersCard projectId={project.id} members={members} accounts={accounts} />

      <section className="card">
        <h2>Books</h2>
        <p className="hint">
          Open a book to assign its chapters or reopen an approved one. USFM exports verse text
          only — see the book page for what that leaves out.
        </p>
        {books.length === 0 ? (
          <p className="empty">This project has no books.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Book</th>
                  <th className="num">Chapters</th>
                  <th className="num">Assigned</th>
                  <th className="num">Approved</th>
                  <th>Verses done</th>
                  <th className="num">Flagged</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {books.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/projects/${project.id}/books/${b.id}`}>
                        {b.name}
                      </Link>{' '}
                      <span className="muted mono">{b.code}</span>
                    </td>
                    <td className="num">{b.chapter_count}</td>
                    <td className="num">{b.chapters_assigned}</td>
                    <td className="num">{b.chapters_approved}</td>
                    <td>
                      <Progress done={b.verses_done} total={b.verse_count} />
                    </td>
                    <td className="num">
                      {b.verses_flagged > 0 ? (
                        <span className="badge flag">{b.verses_flagged}</span>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td className="nowrap">
                      <a href={`/projects/${project.id}/books/${b.id}/export`} download>
                        USFM
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
