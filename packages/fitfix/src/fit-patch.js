/**
 * fit-patch.js -- read and modify FIT files byte by byte. No dependencies.
 *
 * Approach: the file is NOT decoded and re-encoded. Instead the definition
 * messages are parsed far enough to learn the byte offsets of each field, and
 * then individual field values are overwritten in the raw buffer. Everything
 * left alone -- unknown messages, manufacturer fields, developer fields,
 * sensor data -- survives untouched.
 *
 * A decode/encode roundtrip through a profile library loses exactly that data
 * and produces files that Garmin Connect rejects.
 */

// ---------------------------------------------------------------- base types
//
// Keyed by the base type NUMBER -- the low five bits of the base type byte --
// not by the canonical byte. The byte also carries an endian flag in bit 7 and
// two reserved bits, so a table keyed by 0x84 only matches an encoder that
// writes exactly 0x84. Keying by 0x84 & 0x1f == 4 handles every variant of
// uint16; the previous form fell through to `byte` for 77 of the 256 possible
// bytes, silently reading a uint16 array one byte at a time.
//
// [name, element size, invalid value, signed?]
// biome-ignore format: the columns are aligned on purpose, this is a table
const BASE_TYPES = {
   0: ['enum',    1, 0xff,       false],
   1: ['sint8',   1, 0x7f,       true ],
   2: ['uint8',   1, 0xff,       false],
   3: ['sint16',  2, 0x7fff,     true ],
   4: ['uint16',  2, 0xffff,     false],
   5: ['sint32',  4, 0x7fffffff, true ],
   6: ['uint32',  4, 0xffffffff, false],
   7: ['string',  1, 0x00,       false],
   8: ['float32', 4, 0xffffffff, false],
   9: ['float64', 8, null,       false],
  10: ['uint8z',  1, 0x00,       false],
  11: ['uint16z', 2, 0x0000,     false],
  12: ['uint32z', 4, 0x00000000, false],
  13: ['byte',    1, 0xff,       false],
  14: ['sint64',  8, null,       true ],
  15: ['uint64',  8, null,       false],
  16: ['uint64z', 8, null,       false],
};

/** Descriptor for a base type: [name, elementSize, invalidValue, signed]. */
export const baseInfo = (b) => BASE_TYPES[b & 0x1f] ?? BASE_TYPES[13];

// ------------------------------------------------------------------ CRC-16
// biome-ignore format: 8 entries per row mirrors the nibble lookup it encodes
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

export function crc16(bytes, crc = 0) {
  for (let i = 0; i < bytes.length; i++) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[bytes[i] & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(bytes[i] >> 4) & 0xf];
  }
  return crc & 0xffff;
}

/**
 * Python-compatible rounding (half-to-even), so ports stay byte-identical.
 *
 * The tie test is exact. `x - Math.floor(x)` is exact for |x| < 2^52, so an
 * epsilon window buys nothing and costs correctness: an absolute tolerance of
 * 8 * EPSILON is wider than one ULP below |x| ~ 16, which swept genuine
 * near-ties into the tie branch and rounded 0.5000000000000001 down to 0 where
 * Python gives 1.
 */
export function roundHalfEven(x) {
  const f = Math.floor(x);
  if (x - f !== 0.5) return Math.round(x);
  return f % 2 === 0 ? f : f + 1;
}

// ------------------------------------------------------------------- parser
/**
 * @returns {{header: Uint8Array, frames: Frame[], fileCrc: number}}
 * Frame = { kind:'def'|'data', bytes:Uint8Array, localType:number,
 *           globalNum:number, def:Def|null }
 * Def   = { globalNum, littleEndian, fields:[{num,size,base,offset}], size }
 */
export function readFit(u8) {
  if (u8.length < 14) throw new Error('too short for a FIT file');
  const headerSize = u8[0];
  if (String.fromCharCode(...u8.subarray(8, 12)) !== '.FIT')
    throw new Error('missing .FIT signature block');

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const dataSize = dv.getUint32(4, true);
  const header = u8.subarray(0, headerSize);
  const end = headerSize + dataSize;
  if (end + 2 > u8.length) throw new Error('data_size does not match the file size');

  // FIT allows several header/data/CRC chunks concatenated into one file.
  // Nothing here handles that, and quietly returning only the first chunk
  // would mean writeFit emits a third of the input with no warning.
  if (end + 2 < u8.length) {
    throw new Error(
      `${u8.length - end - 2} bytes past the end of the data section ` +
        '-- chained FIT files are not supported',
    );
  }

  const frames = [];
  const localDefs = new Array(16).fill(null);
  let p = headerSize;

  while (p < end) {
    const start = p;
    const rh = u8[p];

    if (rh & 0x80) {
      // compressed timestamp header: reuses the most recently set definition
      const local = (rh >> 5) & 0x03;
      const def = localDefs[local];
      if (!def) throw new Error(`data without a definition (local ${local}, compressed)`);
      p += 1 + def.size;
      frames.push({
        kind: 'data',
        bytes: u8.subarray(start, p),
        localType: local,
        globalNum: def.globalNum,
        def,
        compressed: true,
      });
      continue;
    }

    const local = rh & 0x0f;

    if (rh & 0x40) {
      // definition message
      const littleEndian = u8[p + 2] === 0;
      const globalNum = littleEndian ? dv.getUint16(p + 3, true) : dv.getUint16(p + 3, false);
      const nFields = u8[p + 5];
      let q = p + 6;
      // Bounds-check before reading descriptors. Past the buffer u8[q] is
      // undefined, so `offset` becomes NaN, `def.size` becomes NaN, `p`
      // becomes NaN and the loop exits -- having silently parsed one frame of
      // a thirty-frame file, with no error raised anywhere.
      if (q + nFields * 3 > end) throw new Error('definition message runs past the data section');
      const fields = [];
      let offset = 1;
      for (let i = 0; i < nFields; i++, q += 3) {
        const f = { num: u8[q], size: u8[q + 1], base: u8[q + 2], offset };
        offset += f.size;
        fields.push(f);
      }
      if (rh & 0x20) {
        // developer fields
        const nDev = u8[q];
        q += 1;
        if (q + nDev * 3 > end) throw new Error('developer field block runs past the data section');
        for (let i = 0; i < nDev; i++, q += 3) offset += u8[q + 1];
      }
      const def = { globalNum, littleEndian, fields, size: offset - 1 };
      localDefs[local] = def;
      p = q;
      frames.push({ kind: 'def', bytes: u8.subarray(start, p), localType: local, globalNum, def });
    } else {
      const def = localDefs[local];
      if (!def) throw new Error(`data without a definition (local ${local})`);
      p += 1 + def.size;
      frames.push({
        kind: 'data',
        bytes: u8.subarray(start, p),
        localType: local,
        globalNum: def.globalNum,
        def,
      });
    }
  }

  // The records must tile the data section exactly. Overshooting means the
  // last record swallowed the trailing CRC, and writeFit would then emit a
  // longer file with the old CRC promoted into the payload -- silently, and
  // still passing checkIntegrity, because that only re-CRCs the raw bytes.
  if (p !== end) {
    throw new Error(`records end at ${p}, data section ends at ${end} -- file is malformed`);
  }

  return { header, frames, fileCrc: dv.getUint16(end, true) };
}

// ---------------------------------------------------------- read/write fields
const findField = (def, num) => def.fields.find((f) => f.num === num) ?? null;

/**
 * Raw value of a field; null if absent or invalid.
 *
 * CAVEAT: 64-bit base types also return null, indistinguishable from absent.
 * They cannot be read through DataView's integer accessors without BigInt, and
 * patchFrame cannot write them either. Anything auditing a file for content
 * must therefore treat a 64-bit field as *unknown*, not as empty --
 * anonymize.js reports them explicitly for exactly this reason.
 */
export function getField(frame, num, index = 0) {
  const f = findField(frame.def, num);
  if (!f) return null;
  const [name, sz, invalid, signed] = baseInfo(f.base);
  const n = Math.floor(f.size / sz);
  if (index < 0 || index >= n) return null;
  const dv = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength);
  const le = frame.def.littleEndian;
  const at = f.offset + index * sz;

  // float32 is four bytes but emphatically not a uint32: reading it as one
  // returns the IEEE-754 bit pattern, so 12.5 comes back as 1095237632.
  if (name === 'float32') {
    const v = dv.getFloat32(at, le);
    return Number.isNaN(v) ? null : v;
  }

  let v;
  switch (sz) {
    case 1:
      v = signed ? dv.getInt8(at) : dv.getUint8(at);
      break;
    case 2:
      v = signed ? dv.getInt16(at, le) : dv.getUint16(at, le);
      break;
    case 4:
      v = signed ? dv.getInt32(at, le) : dv.getUint32(at, le);
      break;
    default:
      return null;
  }
  return v === invalid ? null : v;
}

export function hasField(frame, num) {
  return findField(frame.def, num) !== null;
}

/**
 * Sets raw values. `values` is {fieldNumber: value | value[] | null}.
 *
 * A scalar `null` invalidates the WHOLE field, including every element of an
 * array. Invalidating only element 0 left an array field looking valid but
 * altered, and callers were already working around it by passing an array of
 * nulls. Pass an array to set elements individually; `undefined` in an array
 * leaves that element alone.
 *
 * Returns a new Uint8Array; the original is left untouched.
 */
export function patchFrame(frame, values) {
  const out = new Uint8Array(frame.bytes);
  const dv = new DataView(out.buffer);
  const le = frame.def.littleEndian;
  for (const [numStr, val] of Object.entries(values)) {
    const f = findField(frame.def, Number(numStr));
    if (!f) throw new Error(`field ${numStr} missing in message ${frame.globalNum}`);
    const [name, sz, invalid, signed] = baseInfo(f.base);
    const n = Math.floor(f.size / sz);
    // A bare null means "this field is not present", which for an array means
    // every element, not just the first.
    const arr = Array.isArray(val)
      ? val.slice(0, n)
      : new Array(n).fill(val === null ? null : undefined);
    if (!Array.isArray(val) && val !== null) arr[0] = val;
    while (arr.length < n) arr.push(undefined);
    for (let i = 0; i < n; i++) {
      const raw = arr[i];
      if (raw === undefined) continue; // leave this element as is
      const at = f.offset + i * sz;

      // Floats are stored, not rounded. Going through roundHalfEven and
      // setUint32 wrote the integer 12 for 12.5, which reads back as 1.68e-44.
      if (name === 'float32') {
        dv.setFloat32(at, raw === null ? Number.NaN : raw, le);
        continue;
      }

      const v = raw === null ? invalid : roundHalfEven(raw);
      if (!Number.isFinite(v)) {
        // DataView coerces NaN and +/-Infinity to 0, so an arithmetic slip
        // upstream would be written as a confident real value.
        throw new Error(`field ${numStr} in message ${frame.globalNum}: refusing to write ${raw}`);
      }
      switch (sz) {
        case 1:
          signed ? dv.setInt8(at, v) : dv.setUint8(at, v);
          break;
        case 2:
          signed ? dv.setInt16(at, v, le) : dv.setUint16(at, v, le);
          break;
        case 4:
          signed ? dv.setInt32(at, v, le) : dv.setUint32(at, v, le);
          break;
        default:
          throw new Error(`base type ${f.base} cannot be written`);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------- writing
/** Assembles a file from header + frame bytes (data_size + both CRCs). */
export function writeFit(header, frameBytes) {
  const bodyLen = frameBytes.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(header.length + bodyLen + 2);
  out.set(header, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, bodyLen, true);
  // A header CRC of 0x0000 means "not present" and is legal; recomputing it
  // would change bytes on a file that asked us not to, breaking the no-op
  // roundtrip guarantee for inputs Garmin happens never to produce.
  if (header.length >= 14 && dv.getUint16(12, true) !== 0) {
    dv.setUint16(12, crc16(out.subarray(0, 12)), true);
  }
  let p = header.length;
  for (const b of frameBytes) {
    out.set(b, p);
    p += b.length;
  }
  dv.setUint16(p, crc16(out.subarray(0, p)), true);
  return out;
}

/** Integrity check, equivalent to decoder.checkIntegrity(). */
export function checkIntegrity(u8) {
  try {
    const { header, fileCrc } = readFit(u8);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const end = header.length + dv.getUint32(4, true);
    if (header.length >= 14) {
      const hc = dv.getUint16(12, true);
      if (hc !== 0 && hc !== crc16(u8.subarray(0, 12))) return false;
    }
    return crc16(u8.subarray(0, end)) === fileCrc;
  } catch {
    return false;
  }
}
