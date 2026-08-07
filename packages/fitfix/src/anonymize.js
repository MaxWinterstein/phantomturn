/**
 * anonymize.js -- strip personal data out of a FIT file.
 *
 * DESIGN: KEEP-LIST, NOT SCRUB-LIST
 *
 * The first version of this named the things it knew were sensitive and left
 * everything else alone. That is the wrong way round for a format like FIT. A
 * Garmin activity carries a dozen undocumented proprietary message types, and
 * an audit of the output found the real session date sitting in message 162,
 * a BLE device address in message 147, resting and max heart rate in message
 * 216, and a sleep/wake schedule in message 79 -- none of which the scrubber
 * had ever heard of. Worse, message 162 held the original `time_created`, so
 * the date rebase could be reversed from the file itself.
 *
 * So: enumerate what is *needed* and drop the rest. Anything this module has
 * not been taught to reason about does not survive. That fails safe as the
 * format grows, rather than leaking every time Garmin adds a message number.
 *
 * WHAT SURVIVES
 * The messages a pool swim analysis actually reads -- session, lap, length,
 * event, activity, plus enough of file_id and device_info to identify the
 * device model. Every duration, distance, stroke count and lap boundary is
 * untouched, and timestamps keep their exact relative spacing, so an
 * anonymized file still reproduces whatever went wrong.
 *
 * WHAT DOES NOT
 * The per-second `record` stream (and with it the heart-rate series), the user
 * profile, sensor identifiers, device settings, and every undocumented message.
 *
 * Runs in the browser as well as in Node -- it imports nothing but fit-patch.js.
 */
import { baseInfo, getField, hasField, patchFrame, readFit, writeFit } from './fit-patch.js';

/**
 * Every file is rebased so its earliest timestamp lands exactly here:
 * 2010-01-01T00:00:00Z, expressed in the FIT epoch (seconds since 1989-12-31).
 *
 * A rebase, not a fixed offset. A constant published in this source file is
 * trivially reversible; here the delta is derived from the file's own start
 * and stored nowhere. That only holds if *every* absolute timestamp moves --
 * one survivor and the delta is recoverable by subtraction, which is exactly
 * how the previous version was defeated. Hence TIME_FIELDS below is backed up
 * by a range heuristic, and anything not understood is dropped entirely.
 */
export const ANONYMIZED_START = 631_238_400;

/** FIT epoch is 1989-12-31. This is roughly 2024, used as a "did it run" test. */
const RECENT = 1_072_915_200;

/** Plausible span for a real `date_time`: 2000-01-01 to 2040-01-01, FIT epoch. */
const DATE_MIN = 315_619_200;
const DATE_MAX = 1_577_923_200;

const MSG = {
  fileId: 0,
  sport: 12,
  session: 18,
  lap: 19,
  event: 21,
  deviceInfo: 23,
  activity: 34,
  fileCreator: 49,
  length: 101,
};

/**
 * Data messages retained. Everything else is dropped, including the entire
 * `record` stream -- it carries the per-second heart rate and nothing the
 * swim logic reads. Definition messages are always kept: local message types
 * are reused across a file, so removing a definition would desynchronise the
 * data messages that still reference it.
 */
const KEEP = new Set(Object.values(MSG));

/**
 * Absolute timestamp fields, per kept message. Field 253 is `timestamp`
 * throughout FIT; the rest are named because field 2 is `start_time` on a lap
 * but `product` on file_id, so shifting it blindly would corrupt the latter.
 */
const TIME_FIELDS = {
  [MSG.fileId]: [4], // time_created
  [MSG.session]: [2], // start_time
  [MSG.lap]: [2], // start_time
  [MSG.length]: [2], // start_time
  [MSG.activity]: [5], // local_timestamp
};

/**
 * Numeric identity fields, cleared to the base type's invalid value.
 * device_info carries several: the serial, the ANT device number and a 6-byte
 * field that in these files held a BLE random-static address.
 */
const REDACT = {
  [MSG.fileId]: [3], // serial_number
  [MSG.deviceInfo]: [3, 21, 24, 29], // serial, ant_device_number, +2 hardware ids
};

const isString = (field) => baseInfo(field.base)[0] === 'string';
const elemSize = (field) => baseInfo(field.base)[1];
/** patchFrame can write 1, 2 and 4 byte elements; 64-bit types it cannot. */
const WRITABLE = new Set([1, 2, 4]);

/** True when a 4-byte field holds something that looks like a real date. */
function looksLikeDate(frame, field) {
  if (elemSize(field) !== 4 || field.size !== 4) return false;
  const v = getField(frame, field.num);
  return v !== null && v >= DATE_MIN && v <= DATE_MAX;
}

/** Timestamp fields of a frame: the named ones plus anything in date range. */
function timeFieldsOf(frame) {
  const named = [253, ...(TIME_FIELDS[frame.globalNum] ?? [])].filter((n) => hasField(frame, n));
  const sniffed = frame.def.fields.filter((f) => looksLikeDate(frame, f)).map((f) => f.num);
  return [...new Set([...named, ...sniffed])];
}

/** Earliest absolute timestamp in the file, or null if it carries none. */
function findOrigin(frames) {
  let earliest = null;
  for (const frame of frames) {
    if (frame.kind !== 'data' || !KEEP.has(frame.globalNum)) continue;
    for (const num of timeFieldsOf(frame)) {
      const v = getField(frame, num);
      if (v === null || v <= 0) continue;
      if (earliest === null || v < earliest) earliest = v;
    }
  }
  return earliest;
}

/** Zeroes a string field. Returns true if it held anything. */
function clearString(bytes, field) {
  const slice = bytes.subarray(field.offset, field.offset + field.size);
  const had = slice.some((b) => b !== 0);
  slice.fill(0);
  return had;
}

/**
 * Removes personal data from a FIT file.
 *
 * @param {Uint8Array} u8
 * @returns {{ bytes: Uint8Array, removed: string[] }} the anonymized file and a
 *   plain-language list of what was actually taken out. Entries appear only
 *   when something was genuinely present, so an already-clean file reports an
 *   empty list rather than claiming credit for work it did not do.
 */
export function anonymize(u8) {
  const { header, frames } = readFit(u8);
  const origin = findOrigin(frames);
  const shift = origin === null ? 0 : ANONYMIZED_START - origin;

  const out = [];
  const dropped = new Map();
  const counts = { ids: 0, strings: 0, timestamps: 0 };

  for (const frame of frames) {
    if (frame.kind !== 'data') {
      out.push(frame.bytes);
      continue;
    }
    if (!KEEP.has(frame.globalNum)) {
      dropped.set(frame.globalNum, (dropped.get(frame.globalNum) ?? 0) + 1);
      continue;
    }

    const patch = {};

    for (const num of REDACT[frame.globalNum] ?? []) {
      const field = frame.def.fields.find((f) => f.num === num);
      if (!field || !WRITABLE.has(elemSize(field))) continue;
      if (getField(frame, num) !== null) counts.ids++;
      patch[num] = new Array(Math.floor(field.size / elemSize(field))).fill(null);
    }

    if (shift !== 0) {
      for (const num of timeFieldsOf(frame)) {
        const v = getField(frame, num);
        if (v === null) continue;
        patch[num] = v + shift;
        counts.timestamps++;
      }
    }

    const bytes = Object.keys(patch).length
      ? patchFrame(frame, patch)
      : new Uint8Array(frame.bytes);

    // Every string in a kept message goes: product names, activity names and
    // sensor descriptors are all either identifying or unnecessary.
    for (const field of frame.def.fields) {
      if (isString(field) && clearString(bytes, field)) counts.strings++;
    }

    out.push(bytes);
  }

  const removed = [];
  if (counts.ids) removed.push(`Device serial and hardware identifiers (${counts.ids})`);
  if (counts.strings) removed.push(`Names and text fields (${counts.strings})`);
  if (dropped.size) {
    const total = [...dropped.values()].reduce((a, b) => a + b, 0);
    removed.push(
      `${total} records the swim analysis does not need — heart-rate stream, ` +
        `user profile, sensor IDs, device settings (${dropped.size} message types)`,
    );
  }
  if (counts.timestamps) {
    removed.push(
      `Real date and time — ${counts.timestamps} timestamps rebased, ` +
        'relative timing preserved, original not recoverable',
    );
  }

  return { bytes: writeFit(header, out), removed };
}

/**
 * Reports anything that might still identify someone.
 *
 * Deliberately not the inverse of `anonymize()`. The previous audit checked
 * the same four fields the scrubber wrote and so could only ever agree with
 * it; it returned a clean bill of health for files containing a name, a
 * device address and the real session date. This one flags whatever it cannot
 * account for -- unknown messages, date-shaped numbers, leftover text, and
 * 64-bit fields that `getField` cannot even read -- so silence means silence,
 * not ignorance.
 *
 * @returns {string[]} problems found; empty means nothing suspicious.
 */
export function audit(u8) {
  const problems = new Set();
  const { frames } = readFit(u8);

  for (const frame of frames) {
    if (frame.kind !== 'data') continue;

    if (!KEEP.has(frame.globalNum)) {
      problems.add(`message ${frame.globalNum} is not on the keep-list and was not dropped`);
      continue;
    }

    for (const num of REDACT[frame.globalNum] ?? []) {
      if (getField(frame, num) !== null)
        problems.add(`message ${frame.globalNum} field ${num} is set`);
    }

    for (const field of frame.def.fields) {
      if (isString(field)) {
        const slice = frame.bytes.subarray(field.offset, field.offset + field.size);
        if (slice.some((b) => b !== 0)) {
          problems.add(`message ${frame.globalNum} field ${field.num} still holds text`);
        }
        continue;
      }
      if (!WRITABLE.has(elemSize(field))) {
        // getField returns null for 64-bit types, so neither the wipe nor this
        // audit can see inside them. Say so rather than imply they are clean.
        problems.add(
          `message ${frame.globalNum} field ${field.num} is a 64-bit type, not inspected`,
        );
        continue;
      }
      const v = getField(frame, field.num);
      if (v !== null && v > RECENT && v <= DATE_MAX) {
        problems.add(`message ${frame.globalNum} field ${field.num} looks like a real date`);
      }
    }
  }

  return [...problems];
}
