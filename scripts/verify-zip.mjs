#!/usr/bin/env node
/**
 * Hands a generated archive to an extractor this repository did not write.
 *
 *   npm run verify-zip
 *
 * `scripts/test-zip.mjs` round-trips the archive through `node:zlib` and the
 * documented offsets, which is a real check but shares an author with the
 * writer. A format bug that both sides agree on would pass it and still be
 * rejected by whatever the publisher opens the file with — the one place
 * nobody in this project would see the failure.
 *
 * So this uses the operating system's own extractor: `unzip` where there is
 * one, and PowerShell's Expand-Archive on Windows. It builds a realistic
 * archive with the actual USFM generator, extracts it, and compares every
 * byte.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProjectUsfm } from '../src/lib/usfm.ts';
import { createZip } from '../src/lib/zip.ts';

const OK = '  [32mok[0m   ';
const BAD = '  [31mFAIL[0m ';

let failures = 0;
function check(condition, msg, detail) {
  if (condition) console.log(OK + msg);
  else {
    failures += 1;
    console.log(BAD + msg);
    if (detail) console.log('       ' + String(detail).split('\n')[0]);
  }
}

// A project shaped like a real one: two books, non-Latin script in the verse
// text, and an untranslated verse.
const project = { name: 'Tamil Pilot', languageCode: 'ta' };
const books = [
  {
    code: 'GEN', name: 'Genesis', canonName: 'Genesis', sortOrder: 1, testament: 'ot',
    chapters: [
      { number: 1, verses: [
        { number: 1, text: 'ஆதியிலே தேவன் வானத்தையும் பூமியையும் சிருஷ்டித்தார்.' },
        { number: 2, text: '' },
      ] },
    ],
  },
  {
    code: 'MAT', name: 'Matthew', canonName: 'Matthew', sortOrder: 40, testament: 'nt',
    chapters: [
      { number: 1, verses: [{ number: 1, text: 'The book of the generation of Jesus Christ.' }] },
      { number: 2, verses: [{ number: 1, text: 'Now when Jesus was born.' }] },
    ],
  },
];

const archive = buildProjectUsfm(project, books, new Date('2026-08-21T10:30:00Z'));
const zip = createZip(archive.entries, new Date('2026-08-21T10:30:00Z'));

const dir = mkdtempSync(join(tmpdir(), 'sb-zip-'));
const zipPath = join(dir, archive.filename);
writeFileSync(zipPath, zip);

console.log(`\n${archive.entries.length} entries, ${zip.length} bytes -> ${zipPath}\n`);

try {
  const out = join(dir, 'out');
  let extractor;

  if (process.platform === 'win32') {
    extractor = 'PowerShell Expand-Archive';
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${out}' -Force`],
      { stdio: 'pipe' },
    );
  } else {
    extractor = 'unzip';
    // -t first: it validates every CRC and reports a corrupt archive as such.
    execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' });
    execFileSync('unzip', ['-q', zipPath, '-d', out], { stdio: 'pipe' });
  }

  check(true, `${extractor} accepted the archive`);

  for (const entry of archive.entries) {
    const path = join(out, entry.name);
    if (!existsSync(path)) {
      check(false, `${entry.name} was extracted`, 'file missing after extraction');
      continue;
    }
    const extracted = readFileSync(path, 'utf8');
    check(
      extracted === entry.content,
      `${entry.name} matches byte for byte (${entry.content.length} chars)`,
      `extracted ${extracted.length} chars`,
    );
  }

  // Canonical order, not filename order: Genesis before Matthew.
  check(
    archive.entries[0].name.startsWith('01GEN') && archive.entries[1].name.startsWith('41MAT'),
    'books are in canonical order inside the archive',
    archive.entries.map((e) => e.name).join(', '),
  );
} catch (err) {
  check(false, 'the extractor rejected the archive', err.stderr?.toString() || err.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failures > 0) {
  console.log(`[31m${failures} check(s) failed.[0m\n`);
  process.exit(1);
}
console.log('[32mThe archive opens in an extractor this repository did not write.[0m\n');
