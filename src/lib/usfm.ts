/**
 * USFM generation (DB §14, R-USFM-1/2/3).
 *
 * Deliberately dependency-free and free of `server-only`: this module is pure,
 * takes plain data, returns a string, and is unit-tested directly. Export is
 * the one console operation whose output leaves the system and is opened by
 * someone else's software, so it is the one worth testing away from a database.
 *
 * WHAT THIS PRODUCES, AND WHY IT CANNOT PRODUCE MORE
 *
 * R-USFM-1: a verse row stores translated verse text only. Paragraph breaks,
 * section headings, poetry lines, footnotes, and cross-references are not verse
 * text and are deliberately not stored. R-USFM-2 puts the consequence plainly:
 * either markers live in a sidecar structure, or export produces structurally
 * plain USFM that the publisher's operator re-marks.
 *
 * No sidecar exists in the schema. `app.chapter_markup` is named in R-USFM-2 as
 * one of the two options and has never been created, so structurally plain is
 * not a choice made here — it is the only output the stored data can support.
 * R-USFM-3 forbids export from requiring any schema element the app's write
 * path does not maintain, which closes the question: if the sidecar is ever
 * built, this module gains markers and the decision is recorded there first.
 *
 * The practical consequence for whoever receives the file: every chapter opens
 * with a single `\p`, and no other structure is asserted. Verses are correct;
 * paragraphing, headings, and poetry are not attempted rather than guessed.
 */

export interface ExportVerse {
  number: number;
  text: string;
}

export interface ExportChapter {
  number: number;
  verses: ExportVerse[];
}

export interface ExportBook {
  /** USFM three-letter code, e.g. MAT. */
  code: string;
  /** The project's name for the book, which may be in the target language. */
  name: string;
  /** The canonical English name, used where a tool expects something recognisable. */
  canonName: string;
  /** ref.book_canon.sort_order: 1–39 for OT, 40–66 for NT. */
  sortOrder: number;
  testament: 'ot' | 'nt';
  chapters: ExportChapter[];
}

export interface ExportProject {
  name: string;
  languageCode: string;
}

export interface UsfmResult {
  filename: string;
  content: string;
  /** Conditions the operator should know about before sending the file on. */
  warnings: string[];
  stats: {
    chapters: number;
    verses: number;
    emptyVerses: number;
  };
}

/**
 * Paratext's book file number.
 *
 * Not the same as the canonical sort order: Paratext reserves 40 (it was
 * historically used for the intertestamental gap), so the New Testament runs
 * 41–67 while `ref.book_canon` numbers it 40–66. Off by one here and the
 * publishing tool sorts Matthew before Malachi, or refuses the file outright.
 */
export function paratextNumber(sortOrder: number, testament: 'ot' | 'nt'): number {
  return testament === 'nt' ? sortOrder + 1 : sortOrder;
}

/**
 * A short project abbreviation for the filename.
 *
 * Paratext's convention is <NN><CODE><ABBREV>.usfm. The abbreviation is
 * cosmetic — nothing parses it — but a filename that collides across projects
 * is a real hazard on a coordinator's desktop, where exports from two projects
 * land in the same downloads folder.
 */
function abbreviate(projectName: string): string {
  const cleaned = projectName.replace(/[^A-Za-z0-9]+/g, '');
  return (cleaned.slice(0, 8) || 'PROJ').toUpperCase();
}

/**
 * Flattens verse text onto one line.
 *
 * A newline inside verse text would end the `\v` line and make the remainder
 * look like body text belonging to no verse — the file would still open, and
 * the verse would be silently truncated in whatever the publisher sees. That is
 * the worst failure mode available here, so it is handled rather than assumed
 * away: text arrives from an editor, and editors produce newlines.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface UsfmSummary {
  startsWithId: boolean;
  chapters: number;
  paragraphs: number;
  verses: number;
}

/**
 * Counts the markers in generated USFM.
 *
 * Exists so that nothing outside this file has to write a backslash literal.
 * In a JavaScript string `'\i'` is just `'i'`, and in a regular expression
 * `\v` is a vertical tab — a single backslash does not fail loudly, it
 * quietly asserts something else and the check passes by not testing what it
 * claims to. That defect reached CI once in `verify-e2e.mjs` and survived a
 * local inspection, because `JSON.stringify` renders one backslash as two.
 *
 * Every marker literal in this project now lives here, in a file whose own
 * unit tests compare these counts against known fixtures — so an escaping
 * mistake breaks a test rather than silently weakening one.
 */
export function summariseUsfm(content: string): UsfmSummary {
  return {
    startsWithId: content.startsWith('\\id '),
    chapters: (content.match(/^\\c /gm) ?? []).length,
    paragraphs: (content.match(/^\\p$/gm) ?? []).length,
    verses: (content.match(/^\\v /gm) ?? []).length,
  };
}

export function buildUsfm(project: ExportProject, book: ExportBook): UsfmResult {
  const lines: string[] = [];
  const warnings: string[] = [];

  let verseCount = 0;
  let emptyCount = 0;
  let backslashVerses = 0;

  // \id must be first. The trailing text is free-form and conventionally
  // identifies the source.
  lines.push(`\\id ${book.code} ${project.name}`);
  lines.push('\\ide UTF-8');
  lines.push(`\\h ${book.name}`);
  lines.push(`\\toc1 ${book.name}`);
  lines.push(`\\toc2 ${book.name}`);
  lines.push(`\\toc3 ${book.code}`);
  lines.push(`\\mt1 ${book.name}`);

  const chapters = [...book.chapters].sort((a, b) => a.number - b.number);

  for (const chapter of chapters) {
    lines.push(`\\c ${chapter.number}`);

    // The only structural marker asserted. USFM expects verses to sit inside a
    // paragraph; without this most tools complain, and with more than this the
    // export would be inventing structure nobody recorded (R-USFM-1).
    lines.push('\\p');

    const verses = [...chapter.verses].sort((a, b) => a.number - b.number);
    for (const verse of verses) {
      verseCount += 1;
      const text = flatten(verse.text);

      if (text === '') {
        emptyCount += 1;
        // The verse marker is emitted even with no text. Dropping it would
        // renumber nothing but would leave a gap the publisher reads as a
        // deliberate omission rather than as work not yet done.
        lines.push(`\\v ${verse.number}`);
        continue;
      }

      // A backslash in translated text will be read as a marker by the
      // publishing tool. It cannot be escaped in USFM, so it is reported rather
      // than silently altered — changing a translator's text during export is
      // not this program's decision to make.
      if (text.includes('\\')) backslashVerses += 1;

      lines.push(`\\v ${verse.number} ${text}`);
    }
  }

  if (emptyCount > 0) {
    warnings.push(
      `${emptyCount} of ${verseCount} verses have no text and were exported as empty verse markers.`,
    );
  }
  if (backslashVerses > 0) {
    warnings.push(
      `${backslashVerses} verse(s) contain a backslash, which the publishing tool will read as a marker. ` +
        'The text was exported unchanged; check these before sending the file on.',
    );
  }
  warnings.push(
    'Structurally plain: paragraphs, headings, poetry, and footnotes are not stored and must be re-marked.',
  );

  const number = String(paratextNumber(book.sortOrder, book.testament)).padStart(2, '0');

  return {
    filename: `${number}${book.code}${abbreviate(project.name)}.usfm`,
    // USFM files are line-oriented and conventionally newline-terminated.
    content: lines.join('\n') + '\n',
    warnings,
    stats: { chapters: chapters.length, verses: verseCount, emptyVerses: emptyCount },
  };
}
