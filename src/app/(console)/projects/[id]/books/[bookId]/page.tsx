import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProject, listBooks, listChapters, listMembers } from '@/lib/queries';
import { ChapterTable } from './chapters';

export default async function BookPage({
  params,
}: {
  params: Promise<{ id: string; bookId: string }>;
}) {
  const { id, bookId } = await params;

  const project = await getProject(id);
  if (!project) notFound();

  const books = await listBooks(id);
  const book = books.find((b) => b.id === bookId);
  if (!book) notFound();

  const [chapters, members] = await Promise.all([listChapters(bookId), listMembers(id)]);

  // Assigning a non-member produces a chapter its assignee cannot read — the
  // RPC refuses it, and the refusal would look like a bug rather than a
  // mis-assignment. The pickers offer members only, split by role so a
  // coordinator is not choosing a reviewer from a list of translators.
  const translators = members.filter((m) => !m.anonymised && m.role !== 'reviewer');
  const reviewers = members.filter((m) => !m.anonymised && m.role !== 'translator');

  return (
    <>
      <p className="breadcrumb">
        <Link href="/projects">Projects</Link> /{' '}
        <Link href={`/projects/${project.id}`}>{project.name}</Link> / {book.name}
      </p>
      <div className="page-head">
        <h1>
          {book.name} <span className="muted mono">{book.code}</span>
        </h1>
        <p>
          {book.chapter_count} chapters · {book.verse_count.toLocaleString()} verses ·{' '}
          {book.chapters_approved} approved
        </p>
      </div>

      {members.length === 0 ? (
        <p className="notice warn">
          This project has no members, so nothing can be assigned yet.{' '}
          <Link href={`/projects/${project.id}`}>Add members first</Link>.
        </p>
      ) : null}

      <ChapterTable
        projectId={project.id}
        chapters={chapters}
        translators={translators}
        reviewers={reviewers}
      />
    </>
  );
}
