import { deflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP writer (WEB §6.9).
 *
 * Exists so that exporting a whole project is one download rather than sixty-six.
 * USFM is one file per book by convention, so the container has to hold many
 * files, and a zip is what a publisher expects to receive.
 *
 * WHY NOT A LIBRARY
 *
 * This repository has four runtime dependencies and a hand-written stylesheet,
 * and the reason is auditability rather than minimalism: the console holds the
 * service key, so every package in its tree is something that could read it.
 * Writing a zip is a few hundred bytes of header format that has not changed
 * since 1989, and the compression comes from `node:zlib`, which is already
 * present. That trade is worth making here and would not be for something with
 * real algorithmic depth.
 *
 * WHAT IT DELIBERATELY DOES NOT SUPPORT
 *
 * Zip64, encryption, directory entries, and archives over 4 GB. A whole-Bible
 * project is a few megabytes of highly compressible text, so those limits are
 * unreachable here — but they are limits, and `createZip` throws rather than
 * writing a corrupt archive if one is ever approached.
 */

export interface ZipEntry {
  /** Path inside the archive. ASCII only; see the check in createZip. */
  name: string;
  content: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date/time, which is what the format stores. Seconds have two-second resolution. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  // The epoch is 1980. Anything earlier cannot be represented, and silently
  // writing a wrong date is worse than refusing.
  if (year < 1980) throw new Error('ZIP timestamps cannot predate 1980');
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const MAX_SIZE = 0xffffffff;

/**
 * Builds an archive from entries, in the order given.
 *
 * Order is preserved rather than sorted: the caller supplies books in canonical
 * order, and a publisher listing the archive should see Genesis before Exodus
 * rather than 01GEN before 41MAT sorted as strings.
 */
export function createZip(entries: readonly ZipEntry[], now: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(now);

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    // Non-ASCII names need the UTF-8 flag bit and interoperate poorly with
    // older tools. Book codes and project abbreviations are ASCII by
    // construction, so this is a guard against a future caller, not a
    // limitation anyone will meet.
    // eslint-disable-next-line no-control-regex
    if (!/^[\x20-\x7e]+$/.test(entry.name)) {
      throw new Error(`ZIP entry name must be printable ASCII: ${entry.name}`);
    }

    const nameBuf = Buffer.from(entry.name, 'ascii');
    const raw = Buffer.from(entry.content, 'utf8');
    const compressed = deflateRawSync(raw);

    if (raw.length > MAX_SIZE || compressed.length > MAX_SIZE) {
      throw new Error(`ZIP entry too large for a non-Zip64 archive: ${entry.name}`);
    }

    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract (2.0 = deflate)
    local.writeUInt16LE(0, 6); // general purpose flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // offset of local header
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralDirectory, end]);
}
