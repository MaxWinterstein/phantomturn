/**
 * The generic patcher, against files built here rather than recorded.
 *
 * Synthetic input matters for two reasons. It can carry things the real
 * fixtures do not -- float32 fields, developer fields, a 0x0000 header CRC,
 * deliberate corruption -- and, since the fixtures now hold only the nine
 * message types the anonymizer keeps, it is the only remaining proof of the
 * project's central claim: that unknown messages survive a roundtrip untouched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkIntegrity,
  crc16,
  getField,
  patchFrame,
  readFit,
  roundHalfEven,
  writeFit,
} from '../src/fit-patch.js';

/**
 * Minimal FIT encoder: one definition + one data message per entry.
 *
 * @param {Array<{globalNum:number, fields:Array<{num:number,size:number,base:number}>,
 *   payload:number[], devFields?:number[][]}>} messages
 */
function buildFit(messages, { headerCrc = true } = {}) {
  const body = [];
  messages.forEach((m, i) => {
    const local = i % 16;
    const def = [
      0x40 | local | (m.devFields ? 0x20 : 0),
      0,
      0,
      m.globalNum & 0xff,
      m.globalNum >> 8,
      m.fields.length,
    ];
    for (const f of m.fields) def.push(f.num, f.size, f.base);
    if (m.devFields) {
      def.push(m.devFields.length);
      for (const d of m.devFields) def.push(...d);
    }
    body.push(...def, local, ...m.payload);
  });

  const out = new Uint8Array(14 + body.length + 2);
  const dv = new DataView(out.buffer);
  out[0] = 14;
  out[1] = 0x20;
  dv.setUint16(2, 2189, true);
  dv.setUint32(4, body.length, true);
  out.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  dv.setUint16(12, headerCrc ? crc16(out.subarray(0, 12)) : 0, true);
  out.set(body, 14);
  dv.setUint16(14 + body.length, crc16(out.subarray(0, 14 + body.length)), true);
  return out;
}

const UINT32 = 0x86;
const FLOAT32 = 0x88;
const BYTE = 0x0d;

test('an unknown message survives a roundtrip byte for byte', () => {
  // The whole reason this library patches bytes instead of decoding: a
  // proprietary message it has never heard of must come back untouched.
  const file = buildFit([
    { globalNum: 20, fields: [{ num: 253, size: 4, base: UINT32 }], payload: [1, 2, 3, 4] },
    {
      globalNum: 61_616, // no such message in the FIT profile
      fields: [{ num: 7, size: 6, base: BYTE }],
      // 6 bytes for the regular field plus 2 for the developer field, which
      // the definition declares but the parser only has to skip over.
      payload: [0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0xaa, 0xbb],
      devFields: [[0, 2, 0]],
    },
  ]);

  assert.ok(checkIntegrity(file));
  const { header, frames } = readFit(file);
  const back = writeFit(
    header,
    frames.map((f) => f.bytes),
  );
  assert.deepEqual(back, file, 'unknown message did not survive');

  const unknown = frames.find((f) => f.kind === 'data' && f.globalNum === 61_616);
  assert.ok(unknown, 'unknown message was not parsed');
  assert.deepEqual([...unknown.bytes.subarray(1, 7)], [0xde, 0xad, 0xbe, 0xef, 0x00, 0x11]);
});

test('float32 fields read and write as floats, not as their bit pattern', () => {
  const file = buildFit([
    { globalNum: 20, fields: [{ num: 7, size: 4, base: FLOAT32 }], payload: [0, 0, 0x48, 0x41] },
  ]);
  const { header, frames } = readFit(file);
  const frame = frames.find((f) => f.kind === 'data');

  // 0x41480000 is 12.5. Read as a uint32 it is 1095237632.
  assert.equal(getField(frame, 7), 12.5);

  const patched = patchFrame(frame, { 7: 3.25 });
  const reread = readFit(writeFit(header, [frames[0].bytes, patched]));
  assert.equal(getField(reread.frames[1], 7), 3.25, 'float was rounded to an integer');
});

test('patchFrame refuses NaN and Infinity instead of writing zero', () => {
  const file = buildFit([
    { globalNum: 20, fields: [{ num: 7, size: 4, base: UINT32 }], payload: [1, 0, 0, 0] },
  ]);
  const frame = readFit(file).frames.find((f) => f.kind === 'data');

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => patchFrame(frame, { 7: bad }), /refusing to write/);
  }
  assert.doesNotThrow(() => patchFrame(frame, { 7: 42 }));
});

test('roundHalfEven matches Python on exact ties and near-ties alike', () => {
  // Exact ties: half-to-even, including negatives.
  for (const [x, want] of [
    [0.5, 0],
    [1.5, 2],
    [2.5, 2],
    [3.5, 4],
    [-0.5, 0], // Python gives 0, and strict equality distinguishes 0 from -0
    [-1.5, -2],
    [-2.5, -2],
  ]) {
    assert.equal(roundHalfEven(x), want, `roundHalfEven(${x})`);
  }

  // Near-ties. An absolute epsilon window used to swallow these and round
  // them the wrong way; Python's round() gets them right because the values
  // are not actually ties.
  for (const [x, want] of [
    [0.5000000000000001, 1],
    [1.4999999999999998, 1],
    [2.5000000000000004, 3],
    [4.500000000000001, 5],
    [15.499999999999998, 15],
  ]) {
    assert.equal(roundHalfEven(x), want, `roundHalfEven(${x})`);
  }
});

test('malformed files are rejected rather than silently half-parsed', () => {
  const good = buildFit([
    { globalNum: 20, fields: [{ num: 7, size: 4, base: UINT32 }], payload: [1, 0, 0, 0] },
    { globalNum: 21, fields: [{ num: 7, size: 4, base: UINT32 }], payload: [2, 0, 0, 0] },
  ]);
  assert.doesNotThrow(() => readFit(good));

  // A definition claiming far more fields than the file holds. This used to
  // make def.size NaN, exit the loop, and return one frame with no error --
  // and checkIntegrity still said the file was fine.
  const hugeNFields = new Uint8Array(good);
  hugeNFields[14 + 5] = 200;
  assert.throws(() => readFit(hugeNFields), /past the data section/);
  assert.equal(checkIntegrity(hugeNFields), false, 'checkIntegrity vouched for a broken file');

  // A field one byte wider than the data actually present, so the records no
  // longer tile the data section. Which error comes out depends on what the
  // misaligned read lands on; what matters is that one does, and that
  // checkIntegrity stops vouching for the file.
  const overshoot = new Uint8Array(good);
  overshoot[14 + 7] = 5; // field size 4 -> 5
  assert.throws(() => readFit(overshoot));
  assert.equal(checkIntegrity(overshoot), false);

  // Two files concatenated. Returning only the first chunk would mean
  // writeFit silently emitted half the input.
  const chained = new Uint8Array(good.length * 2);
  chained.set(good, 0);
  chained.set(good, good.length);
  assert.throws(() => readFit(chained), /chained FIT files/);
});

test('a legal zero header CRC is left alone', () => {
  // 0x0000 means "no header CRC" and is valid. Recomputing it would change
  // bytes on a file that asked us not to, breaking the roundtrip guarantee.
  const file = buildFit(
    [{ globalNum: 20, fields: [{ num: 7, size: 4, base: UINT32 }], payload: [1, 0, 0, 0] }],
    { headerCrc: false },
  );
  const { header, frames } = readFit(file);
  const back = writeFit(
    header,
    frames.map((f) => f.bytes),
  );

  assert.equal(new DataView(back.buffer).getUint16(12, true), 0, 'header CRC was rewritten');
  assert.deepEqual(back, file);
});

test('getField rejects an out-of-range index in both directions', () => {
  const file = buildFit([
    { globalNum: 20, fields: [{ num: 7, size: 4, base: UINT32 }], payload: [1, 0, 0, 0] },
  ]);
  const frame = readFit(file).frames.find((f) => f.kind === 'data');

  assert.equal(getField(frame, 7, 0), 1);
  assert.equal(getField(frame, 7, 1), null, 'read past the end of the field');
  // index -1 used to read backwards into the record header byte.
  assert.equal(getField(frame, 7, -1), null, 'read before the start of the field');
});
