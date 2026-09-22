/**
 * The ZIP reader, exercised on archives built here rather than committed.
 *
 * Deliberately no .zip fixture. `task fixtures:check` audits every tracked
 * .fit, driven off `git ls-files` -- a .fit inside a committed archive is
 * invisible to it, which is exactly the hole AGENTS.md spends a page keeping
 * shut. Building the archives at run time costs a small writer and closes it.
 *
 * The writer below is only as trustworthy as its author, so the reader was
 * also checked during development against archives produced by Python's
 * `zipfile` -- deflated, stored, nested, with a Mac resource fork, with an
 * archive comment, and empty. That is the cross-implementation half; this file
 * is the half that runs in CI.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze } from '../src/swim-repair.js';
import { fitEntries, isZip, listZip, readEntry } from '../src/unzip.js';
import { readFixture } from './fixtures.mjs';

// ------------------------------------------------------------- a zip writer
//
// Independent of the reader on purpose: its own CRC table, its own field
// offsets. A shared helper would let one wrong offset agree with itself.

function crc32(bytes) {
  let c;
  const table = Uint32Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const deflateRaw = async (bytes) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer(),
  );

/**
 * Builds an archive from `[name, bytes]` pairs.
 *
 * `stored` writes method 0; the default deflates through the platform, which
 * is what a real producer does and what the reader has to undo.
 */
async function makeZip(files, { stored = false, comment = '' } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, raw] of files) {
    const nameBytes = new TextEncoder().encode(name);
    const body = stored ? raw : await deflateRaw(raw);
    const method = stored ? 0 : 8;

    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(8, method, true);
    ldv.setUint32(14, crc32(raw), true);
    ldv.setUint32(18, body.length, true);
    ldv.setUint32(22, raw.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(10, method, true);
    cdv.setUint32(16, crc32(raw), true);
    cdv.setUint32(20, body.length, true);
    cdv.setUint32(24, raw.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    parts.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }

  const cdBytes = central.reduce((a, c) => a + c.length, 0);
  const commentBytes = new TextEncoder().encode(comment);
  const eocd = new Uint8Array(22 + commentBytes.length);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, cdBytes, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, commentBytes.length, true);
  eocd.set(commentBytes, 22);

  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let p = 0;
  for (const chunk of all) {
    out.set(chunk, p);
    p += chunk.length;
  }
  return out;
}

// --------------------------------------------------------------------- tests

test('a Garmin export round-trips to the exact bytes the watch wrote', async () => {
  const fit = await readFixture('swim-03.fit');
  const zip = await makeZip([['24366767973_ACTIVITY.fit', fit]]);

  assert.ok(isZip(zip), 'the archive should be recognised as one');
  const entries = fitEntries(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '24366767973_ACTIVITY.fit');

  const out = await readEntry(zip, entries[0]);
  assert.deepEqual(out, fit, 'unzipping must not change a single byte');
  // The point of the exercise: the unpacked bytes are a file the repair reads.
  assert.equal(analyze(out).lengths, analyze(fit).lengths);
});

test('a stored entry is read as well as a deflated one', async () => {
  const fit = await readFixture('swim-03.fit');
  const zip = await makeZip([['swim.fit', fit]], { stored: true });
  const [entry] = fitEntries(zip);
  assert.equal(entry.method, 0);
  assert.deepEqual(await readEntry(zip, entry), fit);
});

test('an archive comment does not hide the central directory', async () => {
  // The end record is found by scanning back, and the comment pushes it away
  // from the end of the file.
  const fit = await readFixture('swim-03.fit');
  const zip = await makeZip([['swim.fit', fit]], { comment: 'x'.repeat(500) });
  assert.equal(fitEntries(zip).length, 1);
  assert.deepEqual(await readEntry(zip, fitEntries(zip)[0]), fit);
});

test('only real .fit entries are offered', async () => {
  const fit = await readFixture('swim-03.fit');
  const junk = new TextEncoder().encode('not a fit file');
  const zip = await makeZip([
    ['DI_CONNECT/', new Uint8Array(0)],
    ['DI_CONNECT/a_ACTIVITY.fit', fit],
    // The watch writes its own card in uppercase.
    ['GARMIN/ACTIVITY/B.FIT', fit],
    // Zipping on a Mac leaves a resource fork beside every file. It matches on
    // extension and is not a FIT file.
    ['__MACOSX/._a_ACTIVITY.fit', junk],
    ['notes.txt', junk],
  ]);

  assert.deepEqual(
    fitEntries(zip).map((e) => e.name),
    ['DI_CONNECT/a_ACTIVITY.fit', 'GARMIN/ACTIVITY/B.FIT'],
  );
  assert.equal(listZip(zip).length, 5, 'listZip still sees everything');
});

test('an empty archive is a zip with nothing in it, not a broken one', async () => {
  const zip = await makeZip([]);
  assert.ok(isZip(zip));
  assert.deepEqual(fitEntries(zip), []);
});

test('a FIT file is not mistaken for an archive', async () => {
  assert.equal(isZip(await readFixture('swim-03.fit')), false);
  assert.equal(isZip(new Uint8Array(0)), false);
});

test('a corrupted entry is refused rather than repaired', async () => {
  // Everything downstream patches bytes at computed offsets and trusts the
  // file to be the one the watch wrote. Truncated input would be repaired into
  // a confidently wrong file, which is worse than an error.
  const fit = await readFixture('swim-03.fit');
  const zip = await makeZip([['swim.fit', fit]], { stored: true });
  const [entry] = fitEntries(zip);

  const damaged = zip.slice();
  // Somewhere inside the stored payload, past the local header and name.
  damaged[entry.localOffset + 30 + 'swim.fit'.length + 64] ^= 0xff;
  await assert.rejects(() => readEntry(damaged, entry), /failed its checksum/);
});

test('an entry running past the end of the archive is refused', async () => {
  const fit = await readFixture('swim-03.fit');
  const zip = await makeZip([['swim.fit', fit]], { stored: true });
  const [entry] = fitEntries(zip);
  await assert.rejects(
    () => readEntry(zip, { ...entry, compressedSize: zip.length + 1 }),
    /runs past the end/,
  );
});

test('encryption and unknown compression are named, not guessed at', async () => {
  const fit = await readFixture('swim-03.fit');
  const zip = await makeZip([['swim.fit', fit]]);
  const [entry] = fitEntries(zip);

  await assert.rejects(() => readEntry(zip, { ...entry, encrypted: true }), /is encrypted/);
  await assert.rejects(
    () => readEntry(zip, { ...entry, method: 14 }),
    /unsupported compression method \(14\)/,
  );
});

test('an implausibly large entry is refused before it is unpacked', async () => {
  // A kilobyte of deflate can declare a gigabyte of output, and the tab that
  // would expand it belongs to the user.
  const fit = await readFixture('swim-03.fit');
  const zip = await makeZip([['swim.fit', fit]]);
  const [entry] = fitEntries(zip);
  await assert.rejects(() => readEntry(zip, { ...entry, size: 2 ** 30 }), /refused as too large/);
});

test('a truncated archive says so instead of throwing something obscure', async () => {
  const fit = await readFixture('swim-03.fit');
  const zip = await makeZip([['swim.fit', fit]]);
  assert.throws(() => listZip(zip.subarray(0, zip.length - 10)), /end-of-central-directory/);
});
