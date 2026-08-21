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

      <MembersCard projectId={project.id} members={members} accounts={accounts} />

      <section className="card">
        <h2>Books</h2>
        <p className="hint">Open a book to assign its chapters or reopen an approved one.</p>
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
