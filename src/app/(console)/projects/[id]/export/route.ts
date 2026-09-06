import { NextResponse } from 'next/server';
import { projectForExport } from '@/lib/queries';
import { requireSession, operatorLabel } from '@/lib/session';
import { query } from '@/lib/db';
import { buildProjectUsfm, type ExportBook, type ExportChapter } from '@/lib/usfm';
import { createZip } from '@/lib/zip';
import { toConsoleError } from '@/lib/errors';

/**
 * Whole-project USFM export, as one zip of per-book files (WEB §6.9).
 *
 * The per-book route exists too, and is the right thing for checking one book.
 * This is for the handoff a publisher actually receives: a sixty-six book
 * project is sixty-six downloads otherwise, and a coordinator assembling that
 * by hand will eventually miss one.
 *
 * Guarded here rather than by the layout, like the per-book route: this is a
 * route handler, so it does not pass through the `(console)` layout, and it
 * returns the full text of every project it is asked for.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
  }

  const { id: projectId } = await params;

  try {
    const rows = await projectForExport(projectId);
    if (rows.length === 0) {
      return new NextResponse('No such project, or it has no books.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    const first = rows[0]!;

    // The query is ordered by book, chapter, verse, so a single pass groups it.
    const books: ExportBook[] = [];
    let book: ExportBook | null = null;
    let chapter: ExportChapter | null = null;

    for (const row of rows) {
      if (!book || book.code !== row.book_code) {
        book = {
          code: row.book_code,
          name: row.book_name,
          canonName: row.canon_name,
          sortOrder: row.sort_order,
          testament: row.testament,
          chapters: [],
        };
        books.push(book);
        chapter = null;
      }
      if (!chapter || chapter.number !== row.chapter_number) {
        chapter = { number: row.chapter_number, verses: [] };
        book.chapters.push(chapter);
      }
      chapter.verses.push({ number: row.verse_number, text: row.text });
    }

    const archive = buildProjectUsfm(
      { name: first.project_name, languageCode: first.language_code },
      books,
    );
    const zip = createZip(archive.entries);

    // Read-only, but this is the operation that removes an entire project's
    // translation text from the system in one action — the strongest case in
    // the console for recording who did it and when (DB R-AUTH-DB-12).
    await query(
      `select app.console_audit($1, $2, $3::uuid, $4, null::jsonb, $5::jsonb)`,
      [
        'project.export',
        'project',
        projectId,
        operatorLabel(session),
        JSON.stringify({
          books: archive.stats.books,
          chapters: archive.stats.chapters,
          verses: archive.stats.verses,
          empty_verses: archive.stats.emptyVerses,
          bytes: zip.length,
        }),
      ],
    );

    return new NextResponse(new Uint8Array(zip), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${archive.filename}"`,
        'Content-Length': String(zip.length),
        'X-Usfm-Warnings': archive.warnings.join(' | ').replace(/[^\x20-\x7e]/g, ''),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const e = toConsoleError(err);
    return new NextResponse(`Export failed: ${e.message}`, {
      status: e.status >= 400 && e.status < 600 ? e.status : 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
