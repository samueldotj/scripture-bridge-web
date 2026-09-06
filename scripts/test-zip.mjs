#!/usr/bin/env node
/**
 * Unit tests for the ZIP writer (WEB §6.9).
 *
 * A hand-written archive format is only worth having if it is checked against
 * something that did not write it. So the round-trip here inflates with
 * `node:zlib` and parses offsets by hand, and `scripts/verify-zip.mjs` goes
 * further by handing a real archive to the operating system's own extractor.
 *
 * The failure this guards against is specific: an archive that looks fine to
 * the code that produced it and is rejected by the publisher's tooling, which
 * is the one place nobody here would see it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { createZip, crc32 } from '../src/lib/zip.ts';

const FIXED = new Date('2026-08-21T10:30:00Z');

/** Reads an archive back using zlib and the documented offsets. */
function readZip(buf) {
  // End of central directory is the last 22 bytes when there is no comment.
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'end-of-central-directory signature');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory signature');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('ascii');

    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const cSize = buf.readUInt32LE(localOffset + 18);
    const uSize = buf.readUInt32LE(localOffset + 22);
    const storedCrc = buf.readUInt32LE(localOffset + 14);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const content = inflateRawSync(buf.subarray(dataStart, dataStart + cSize));

    assert.equal(content.length, uSize, `uncompressed size for ${name}`);
    assert.equal(crc32(content), storedCrc, `crc for ${name}`);

    entries.push({ name, content: content.toString('utf8') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(p - cdOffset, cdSize, 'central directory size matches what was written');
  return entries;
}

test('an archive round-trips through zlib with correct names and content', () => {
  const input = [
    { name: '41MATTEST.usfm', content: '\\id MAT Test\n\\c 1\n\\p\n\\v 1 In the beginning.\n' },
    { name: '01GENTEST.usfm', content: '\\id GEN Test\n\\c 1\n\\p\n\\v 1 A verse.\n' },
  ];
  const out = readZip(createZip(input, FIXED));
  assert.deepEqual(out, input);
});

test('entry order is preserved rather than sorted', () => {
  // The caller supplies canonical order; a publisher listing the archive should
  // see Genesis before Matthew, not 01GEN before 41MAT as strings.
  const entries = readZip(
    createZip(
      [
        { name: '01GEN.usfm', content: 'a' },
        { name: '41MAT.usfm', content: 'b' },
        { name: '02EXO.usfm', content: 'c' },
      ],
      FIXED,
    ),
  );
  assert.deepEqual(entries.map((e) => e.name), ['01GEN.usfm', '41MAT.usfm', '02EXO.usfm']);
});

test('an empty archive is still a valid archive', () => {
  const buf = createZip([], FIXED);
  assert.equal(buf.length, 22);
  assert.deepEqual(readZip(buf), []);
});

test('UTF-8 content survives, including non-Latin script', () => {
  // The whole point of the project: target languages are rarely Latin script.
  const content = '\\id MAT தமிழ்\n\\c 1\n\\p\n\\v 1 ஆதியிலே வார்த்தை இருந்தது.\n';
  const [entry] = readZip(createZip([{ name: '41MAT.usfm', content }], FIXED));
  assert.equal(entry.content, content);
});

test('a large repetitive file compresses rather than merely being stored', () => {
  const content = '\\v 1 the same verse over and over\n'.repeat(2000);
  const buf = createZip([{ name: 'big.usfm', content }], FIXED);
  // Deflate on text this repetitive should be an order of magnitude smaller;
  // if this ever fails, the method field is probably wrong.
  assert.ok(buf.length < content.length / 10, `archive ${buf.length} vs raw ${content.length}`);
  assert.equal(readZip(buf)[0].content, content);
});

test('crc32 matches the known value for a standard input', () => {
  // The canonical check value for "123456789".
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('')), 0);
});

test('a non-ASCII entry name is refused rather than written wrongly', () => {
  // Such a name needs the UTF-8 flag bit; writing it without would produce an
  // archive that extracts under a mangled name on some tools.
  assert.throws(
    () => createZip([{ name: 'tamil-தமிழ்.usfm', content: 'x' }], FIXED),
    /printable ASCII/,
  );
});

test('a timestamp before the ZIP epoch is refused', () => {
  assert.throws(
    () => createZip([{ name: 'a.usfm', content: 'x' }], new Date('1979-01-01T00:00:00Z')),
    /cannot predate 1980/,
  );
});
