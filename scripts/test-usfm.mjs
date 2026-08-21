#!/usr/bin/env node
/**
 * Unit tests for the USFM generator (WEB §6.9).
 *
 *   npm run test-usfm
 *
 * Written as .mjs importing the .ts module directly: Node strips the types at
 * runtime, and keeping the test out of the tsconfig glob avoids needing
 * `allowImportingTsExtensions` for a single file.
 *
 * Export is the only console operation whose output is consumed by software
 * outside this project, and the only one where a defect is invisible here and
 * obvious to the partner organisation. It is worth testing away from a
 * database, which is also why `src/lib/usfm.ts` takes plain data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUsfm, paratextNumber, summariseUsfm } from '../src/lib/usfm.ts';

const project = { name: 'Tamil Pilot', languageCode: 'ta' };

function book(overrides = {}) {
  return {
    code: 'MAT',
    name: 'Matthew',
    canonName: 'Matthew',
    sortOrder: 40,
    testament: 'nt',
    chapters: [
      { number: 1, verses: [{ number: 1, text: 'First verse.' }] },
    ],
    ...overrides,
  };
}

test('the header identifies the book and declares the encoding', () => {
  const { content } = buildUsfm(project, book());
  const lines = content.split('\n');

  // \id must be the first line of a USFM file.
  assert.equal(lines[0], '\\id MAT Tamil Pilot');
  assert.ok(content.includes('\\ide UTF-8'));
  assert.ok(content.includes('\\h Matthew'));
  assert.ok(content.includes('\\toc3 MAT'));
});

test('every chapter opens a paragraph before its verses', () => {
  const { content } = buildUsfm(
    project,
    book({
      chapters: [
        { number: 1, verses: [{ number: 1, text: 'a' }] },
        { number: 2, verses: [{ number: 1, text: 'b' }] },
      ],
    }),
  );
  // USFM expects verses inside a paragraph; a file without \p is rejected or
  // silently reflowed by publishing tools.
  assert.match(content, /\\c 1\n\\p\n\\v 1 a/);
  assert.match(content, /\\c 2\n\\p\n\\v 1 b/);
});

test('chapters and verses are emitted in numeric order regardless of input order', () => {
  const { content } = buildUsfm(
    project,
    book({
      chapters: [
        { number: 2, verses: [{ number: 2, text: 'two' }, { number: 1, text: 'one' }] },
        { number: 1, verses: [{ number: 1, text: 'first' }] },
      ],
    }),
  );
  assert.ok(content.indexOf('\\c 1') < content.indexOf('\\c 2'));
  assert.ok(content.indexOf('\\v 1 one') < content.indexOf('\\v 2 two'));
});

test('an untranslated verse keeps its marker and is counted', () => {
  const result = buildUsfm(
    project,
    book({
      chapters: [
        {
          number: 1,
          verses: [
            { number: 1, text: 'done' },
            { number: 2, text: '' },
            { number: 3, text: '   ' },
          ],
        },
      ],
    }),
  );
  // Dropping the marker would read to a publisher as a deliberate omission
  // rather than as work not yet done.
  assert.ok(result.content.includes('\\v 2\n'));
  assert.ok(result.content.includes('\\v 3\n'));
  assert.equal(result.stats.emptyVerses, 2);
  assert.ok(result.warnings.some((w) => w.includes('2 of 3 verses have no text')));
});

test('a newline inside verse text is flattened rather than left to truncate the verse', () => {
  const { content } = buildUsfm(
    project,
    book({
      chapters: [
        { number: 1, verses: [{ number: 1, text: 'line one\nline two\n\tindented' }] },
      ],
    }),
  );
  // The failure this prevents: everything after the newline stops being part of
  // the verse, the file still opens, and the loss is silent.
  assert.ok(content.includes('\\v 1 line one line two indented'));
  assert.ok(!content.includes('line one\nline two'));
});

test('a backslash in verse text is reported and the text is left unchanged', () => {
  const result = buildUsfm(
    project,
    book({ chapters: [{ number: 1, verses: [{ number: 1, text: 'a \\q marker' }] }] }),
  );
  // Altering a translator's text during export is not this program's decision.
  assert.ok(result.content.includes('\\v 1 a \\q marker'));
  assert.ok(result.warnings.some((w) => w.includes('backslash')));
});

test('the structurally-plain caveat is always present', () => {
  const result = buildUsfm(project, book());
  // R-USFM-2: the receiving operator must know they have to re-mark.
  assert.ok(result.warnings.some((w) => w.includes('Structurally plain')));
});

test('Paratext numbering reserves 40, so the New Testament is offset by one', () => {
  // ref.book_canon numbers MAT 40 and REV 66; Paratext files are 41 and 67.
  assert.equal(paratextNumber(40, 'nt'), 41);
  assert.equal(paratextNumber(66, 'nt'), 67);
  // The Old Testament is unaffected.
  assert.equal(paratextNumber(1, 'ot'), 1);
  assert.equal(paratextNumber(39, 'ot'), 39);
});

test('the filename follows the Paratext convention <NN><CODE><ABBREV>.usfm', () => {
  // "Tamil Pilot" -> "TamilPilot" -> first 8 -> "TAMILPIL".
  assert.equal(buildUsfm(project, book()).filename, '41MATTAMILPIL.usfm');
});

test('a single-digit book number is zero-padded', () => {
  const result = buildUsfm(project, book({
    code: 'GEN', name: 'Genesis', canonName: 'Genesis', sortOrder: 1, testament: 'ot',
  }));
  assert.ok(result.filename.startsWith('01GEN'));
});

test('a project name with punctuation still produces a usable filename', () => {
  const result = buildUsfm({ name: 'Test — Project #2!', languageCode: 'xx' }, book());
  assert.match(result.filename, /^41MAT[A-Z0-9]+\.usfm$/);
});

test('the file ends with a newline', () => {
  assert.ok(buildUsfm(project, book()).content.endsWith('\n'));
});

/**
 * summariseUsfm is the only place outside the generator that knows what a USFM
 * marker looks like. These tests are what stop an escaping mistake in it from
 * silently weakening the verification sequence that depends on it: a wrong
 * escape makes these counts wrong, and a wrong count fails here.
 */
test('summariseUsfm counts the markers in a known file', () => {
  const chapters = [
    { number: 1, verses: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }] },
    { number: 2, verses: [{ number: 1, text: 'c' }] },
    { number: 3, verses: [{ number: 1, text: '' }] },
  ];
  const { content } = buildUsfm(project, book({ chapters }));
  const summary = summariseUsfm(content);

  assert.equal(summary.startsWithId, true);
  assert.equal(summary.chapters, 3);
  // One paragraph per chapter, and no more: anything else would be structure
  // the export invented.
  assert.equal(summary.paragraphs, 3);
  // Four verses including the untranslated one, which keeps its marker.
  assert.equal(summary.verses, 4);
});

test('summariseUsfm does not mistake ordinary text for markers', () => {
  // A verse mentioning "c 1" or containing a lone v must not inflate the
  // counts — the patterns are anchored to the start of a line for this reason.
  const { content } = buildUsfm(
    project,
    book({
      chapters: [
        { number: 1, verses: [{ number: 1, text: 'see c 1 and v 2 and p' }] },
      ],
    }),
  );
  const summary = summariseUsfm(content);
  assert.equal(summary.chapters, 1);
  assert.equal(summary.paragraphs, 1);
  assert.equal(summary.verses, 1);
});
