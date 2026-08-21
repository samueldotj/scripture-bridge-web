import { NextResponse } from 'next/server';
import { bookForExport } from '@/lib/queries';
import { requireSession, operatorLabel } from '@/lib/session';
import { query } from '@/lib/db';
import { buildUsfm, type ExportChapter } from '@/lib/usfm';
import { toConsoleError } from '@/lib/errors';

/**
 * USFM export for one book (DB §14, WEB §6.9).
 *
 * A route handler rather than a Server Action because the result is a file the
 * browser downloads, and an action returns a value to a component.
 *
 * THE GUARD IS HERE, NOT IN A LAYOUT. Route handlers do not pass through the
 * `(console)` layout, and the middleware only checks that a cookie exists. This
 * endpoint returns project content to whoever calls it, so it verifies the
 * session itself — the same reason every Server Action does (WEB R-SEC-WEB-5).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; bookId: string }> },
) {
  let session;
  try {
    session = await requireSession();
  } catch {
    // A signed-out operator following a stale link gets the sign-in page, not a
    // file and not a stack trace.
    return NextResponse.redirect(new URL('/login', _request.url), { status: 303 });
  }

  const { id: projectId, bookId } = await params;

  try {
    const rows = await bookForExport(bookId);
    if (rows.length === 0) {
      return new NextResponse('No such book, or it has no verses.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    const first = rows[0]!;

    // The query is ordered by chapter then verse, so chapters accumulate in
    // order and the generator's own sort is a belt-and-braces check rather than
    // the thing being relied on.
    const chapters: ExportChapter[] = [];
    let current: ExportChapter | null = null;
    for (const row of rows) {
      if (!current || current.number !== row.chapter_number) {
        current = { number: row.chapter_number, verses: [] };
        chapters.push(current);
      }
      current.verses.push({ number: row.verse_number, text: row.text });
    }

    const result = buildUsfm(
      { name: first.project_name, languageCode: first.language_code },
      {
        code: first.book_code,
        name: first.book_name,
        canonName: first.canon_name,
        sortOrder: first.sort_order,
        testament: first.testament,
        chapters,
      },
    );

    // R-AUTH-DB-12 covers privileged operations. Export is read-only and takes
    // no lock, but it is the one operation that removes translation text from
    // the system, and "who took a copy of this project, and when" is a question
    // that gets asked after the fact or not at all.
    await query(
      `select app.console_audit($1, $2, $3::uuid, $4, null::jsonb, $5::jsonb)`,
      [
        'book.export',
        'book',
        bookId,
        operatorLabel(session),
        JSON.stringify({
          project_id: projectId,
          book: first.book_code,
          chapters: result.stats.chapters,
          verses: result.stats.verses,
          empty_verses: result.stats.emptyVerses,
        }),
      ],
    );

    return new NextResponse(result.content, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        // The warnings travel with the response so a scripted caller sees what
        // the screen would have told a person.
        'X-Usfm-Warnings': result.warnings.join(' | ').replace(/[^\x20-\x7e]/g, ''),
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
