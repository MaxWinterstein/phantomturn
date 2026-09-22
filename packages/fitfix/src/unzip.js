/**
 * unzip.js -- just enough ZIP to open what Garmin hands you. No dependencies.
 *
 * "Export Original" on Garmin Connect downloads `activity_<id>.zip`, and the
 * .fit is inside it. Asking people to unpack that first is asking them to find
 * a file manager on a phone, so this reads the archive directly.
 *
 * Deliberately not a general ZIP library. It reads the central directory,
 * handles the two storage methods that exist in practice, verifies CRC-32 and
 * length on the way out, and refuses everything else by name rather than
 * guessing. Browser-safe: the inflating is done by the platform's
 * DecompressionStream, so there is no hand-rolled entropy decoder here and
 * nothing to keep in step with it.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

const STORED = 0;
const DEFLATED = 8;

/** A ZIP comment is a uint16 length, so the record starts at most this far back. */
const MAX_COMMENT = 0xffff;
const EOCD_MIN = 22;

/**
 * Refusal threshold for a single entry, checked against the declared size
 * before anything is decompressed.
 *
 * A pool swim is tens of kilobytes and the longest plausible activity is a few
 * megabytes, so this is three orders of magnitude of headroom -- and it is not
 * really about swims. An archive can declare a kilobyte of deflate that
 * expands to a gigabyte, and the browser tab that expands it is the user's.
 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/**
 * True if these bytes open like a ZIP archive.
 *
 * Tested at the front, not by hunting for the end record: this decides which
 * reader a dropped file goes to, and a FIT file that happened to contain the
 * six bytes of an end-of-central-directory record somewhere in its sensor
 * stream would otherwise be mistaken for an archive.
 */
export function isZip(u8) {
  if (u8.length < 4) return false;
  const sig = new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0, true);
  // PK\x05\x06 is an archive with nothing in it, which is not useful here but
  // is still a zip -- reporting it as one produces "no .fit inside" rather
  // than "this is not a FIT file".
  return sig === SIG_LOCAL || sig === SIG_EOCD;
}

/** Locates the end-of-central-directory record, scanning back from the end. */
function findEocd(u8) {
  const earliest = Math.max(0, u8.length - MAX_COMMENT - EOCD_MIN);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let p = u8.length - EOCD_MIN; p >= earliest; p--) {
    if (dv.getUint32(p, true) !== SIG_EOCD) continue;
    // The comment length has to account for the rest of the file exactly,
    // otherwise this is those four bytes occurring inside the archive data.
    if (dv.getUint16(p + 20, true) === u8.length - p - EOCD_MIN) return p;
  }
  throw new Error('not a ZIP archive: no end-of-central-directory record');
}

/**
 * Every entry in the archive, read from the central directory.
 *
 * The central directory rather than the local headers, because an entry
 * written by a streaming producer carries zero sizes and a zero CRC in its
 * local header and puts the real ones in a trailing data descriptor. The
 * central directory always has them.
 */
export function listZip(u8) {
  const eocd = findEocd(u8);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  if (eocd >= 20 && dv.getUint32(eocd - 20, true) === SIG_EOCD64_LOCATOR) {
    throw new Error('ZIP64 archives are not supported -- unpack it yourself');
  }

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw new Error(`ZIP central directory is damaged at entry ${i + 1}`);
    }
    const flags = dv.getUint16(p + 8, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);

    entries.push({
      // Bit 11 promises UTF-8 and otherwise the name is CP437, but the two
      // agree over ASCII and no Garmin export has ever been anything else.
      name: new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen)),
      method: dv.getUint16(p + 10, true),
      encrypted: (flags & 1) !== 0,
      crc32: dv.getUint32(p + 16, true),
      compressedSize: dv.getUint32(p + 20, true),
      size: dv.getUint32(p + 24, true),
      localOffset: dv.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * The .fit files in the archive, in the order the archive lists them.
 *
 * Case-insensitive, because the watch writes `GARMIN/ACTIVITY/*.FIT` in
 * uppercase and a zip of a card copied straight off it keeps that. Directory
 * entries are skipped, and so is `__MACOSX/`, where a zip made on a Mac keeps
 * a resource fork per file -- one named `._24366767973_ACTIVITY.fit`, which
 * matches on extension and is not a FIT file.
 */
export function fitEntries(u8) {
  return listZip(u8).filter(
    (e) =>
      !e.name.endsWith('/') &&
      /\.fit$/i.test(e.name) &&
      !e.name.startsWith('__MACOSX/') &&
      !e.name.split('/').pop().startsWith('._'),
  );
}

// ------------------------------------------------------------------ CRC-32
let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Inflates, refusing to hold more than the archive promised it would produce.
 *
 * The declared size is the archive's claim, not a fact: a kilobyte of deflate
 * can expand to gigabytes, and the entry that says otherwise is written by
 * whoever built the zip. Reading through `new Response(stream).arrayBuffer()`
 * buffers the whole expansion before any check can run, so the length check in
 * readEntry would arrive after the memory was already gone.
 *
 * Reading chunk by chunk and stopping at the first byte past `limit` bounds it.
 * readEntry still verifies the exact length and the CRC afterwards -- this only
 * caps what can be spent getting there.
 */
async function inflateRaw(bytes, limit, name) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('this browser cannot decompress ZIP files -- unpack it yourself');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        throw new Error(`${name} expands past the ${limit} bytes it declares`);
      }
      chunks.push(value);
    }
  } finally {
    // Releases the underlying source whether this returned or threw.
    await reader.cancel().catch(() => {});
  }

  const out = new Uint8Array(total);
  let p = 0;
  for (const chunk of chunks) {
    out.set(chunk, p);
    p += chunk.length;
  }
  return out;
}

/**
 * Decompresses one entry, and checks it came out the length and CRC the
 * archive said it would.
 *
 * Both checks matter more here than in a general unzipper. Everything
 * downstream patches bytes at computed offsets and trusts the file to be the
 * one the watch wrote; a silently truncated input would be parsed as a
 * malformed FIT file at best, and repaired into a confidently wrong one at
 * worst.
 */
export async function readEntry(u8, entry) {
  if (entry.encrypted) throw new Error(`${entry.name} is encrypted`);
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new Error(`${entry.name} uses an unsupported compression method (${entry.method})`);
  }
  if (entry.size > MAX_ENTRY_BYTES) {
    throw new Error(`${entry.name} unpacks to ${entry.size} bytes, which is refused as too large`);
  }

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const p = entry.localOffset;
  if (p + 30 > u8.length || dv.getUint32(p, true) !== SIG_LOCAL) {
    throw new Error(`${entry.name}: local header is missing or damaged`);
  }
  // The local extra field is allowed to differ in length from the central one,
  // so the data offset has to come from here rather than from the entry.
  const start = p + 30 + dv.getUint16(p + 26, true) + dv.getUint16(p + 28, true);
  const end = start + entry.compressedSize;
  if (end > u8.length) throw new Error(`${entry.name} runs past the end of the archive`);

  const raw = u8.subarray(start, end);
  const out = entry.method === STORED ? raw : await inflateRaw(raw, entry.size, entry.name);

  if (out.length !== entry.size) {
    throw new Error(`${entry.name} unpacked to ${out.length} bytes, expected ${entry.size}`);
  }
  if (crc32(out) !== entry.crc32) throw new Error(`${entry.name} failed its checksum`);
  return out;
}
