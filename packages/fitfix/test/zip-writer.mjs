/**
 * A minimal ZIP writer, for tests only.
 *
 * Deliberately independent of `unzip.js`: its own CRC table, its own field
 * offsets, nothing imported from the code under test. A shared helper would let
 * one wrong offset agree with itself and pass.
 *
 * It exists so that no .zip has to be committed. `task fixtures:check` audits
 * every tracked .fit driven off `git ls-files`, and an archive is one opaque
 * blob to that -- a swim inside a committed zip would be audited by nothing.
 * See AGENTS.md.
 */

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
 * `stored` writes method 0; the default deflates through the platform, which is
 * what a real producer does and what the reader has to undo. `declaredSize`
 * overrides the uncompressed size written into the headers without changing the
 * data -- the shape of a zip bomb, which claims little and expands to a lot.
 */
export async function makeZip(files, { stored = false, comment = '', declaredSize } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, raw] of files) {
    const nameBytes = new TextEncoder().encode(name);
    const body = stored ? raw : await deflateRaw(raw);
    const method = stored ? 0 : 8;
    const size = declaredSize ?? raw.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(8, method, true);
    ldv.setUint32(14, crc32(raw), true);
    ldv.setUint32(18, body.length, true);
    ldv.setUint32(22, size, true);
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
    cdv.setUint32(24, size, true);
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
