/**
 * The anonymizer, and the property the test fixtures depend on.
 *
 * The committed fixtures are already anonymized, so several tests synthesise a
 * "dirty" file first by shifting its timestamps -- otherwise the rebase would
 * never actually be exercised.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ANONYMIZED_START, anonymize, audit } from '../src/anonymize.js';
import {
  checkIntegrity,
  getField,
  hasField,
  patchFrame,
  readFit,
  writeFit,
} from '../src/fit-patch.js';
import { repair } from '../src/swim-repair.js';
import { firstDiff, ORIGINALS, readFixture } from './fixtures.mjs';

/** Reads one field off the first message of a given type. */
const field = (u8, globalNum, num) => {
  const { frames } = readFit(u8);
  const frame = frames.find((f) => f.kind === 'data' && f.globalNum === globalNum);
  return frame ? getField(frame, num) : null;
};

/**
 * Every field 253 in the file. Deliberately does not touch field 2: it is
 * start_time on a lap but `product` on file_id and a string on sensor, and
 * treating it as a timestamp everywhere is the exact trap anonymize.js avoids.
 */
const timestamps = (u8) => {
  const { frames } = readFit(u8);
  return frames
    .filter((f) => f.kind === 'data')
    .map((f) => getField(f, 253))
    .filter((v) => typeof v === 'number' && v > 0);
};

/** Timestamp fields per message, mirroring anonymize.js. */
const EXTRA = { 0: [4], 18: [2], 19: [2], 34: [5], 101: [2] };

/** Moves every timestamp, producing a file that still needs anonymizing. */
function shiftAll(u8, delta) {
  const { header, frames } = readFit(u8);
  const out = frames.map((fr) => {
    if (fr.kind !== 'data') return fr.bytes;
    const patch = {};
    for (const num of [253, ...(EXTRA[fr.globalNum] ?? [])]) {
      if (!hasField(fr, num)) continue;
      const v = getField(fr, num);
      if (v === null) continue;
      patch[num] = v + delta;
    }
    return Object.keys(patch).length ? patchFrame(fr, patch) : fr.bytes;
  });
  return writeFit(header, out);
}

test('anonymize strips identity and leaves a valid file', async () => {
  for (const name of ORIGINALS) {
    const input = await readFixture(name);
    const { bytes } = anonymize(input);

    assert.deepEqual(audit(bytes), [], `${name}: audit found problems`);
    assert.ok(checkIntegrity(bytes), `${name}: anonymized file fails integrity`);
    assert.equal(bytes.length, input.length, `${name}: length changed`);
  }
});

test('anonymize rebases to a fixed instant and preserves spacing', async () => {
  const clean = await readFixture(ORIGINALS[1]);
  const dirty = shiftAll(clean, 500_000_000); // pretend it was never scrubbed
  assert.notEqual(field(dirty, 0, 4), ANONYMIZED_START, 'setup failed to move the dates');

  const { bytes } = anonymize(dirty);

  // The delta comes from the file's own start and is stored nowhere, so the
  // original date cannot be added back the way a published constant could.
  assert.equal(
    field(bytes, 0, 4),
    ANONYMIZED_START,
    'file does not start at the canonical instant',
  );
  assert.ok(
    Math.min(...timestamps(bytes)) >= ANONYMIZED_START,
    'a timestamp predates the canonical instant',
  );

  // Spacing is what keeps an anonymized file useful for debugging.
  const before = timestamps(dirty);
  const after = timestamps(bytes);
  assert.ok(before.length > 10, 'not enough timestamps to compare');
  assert.deepEqual(
    after.map((t) => t - after[0]),
    before.map((t) => t - before[0]),
    'relative timing changed',
  );
});

test('anonymize is idempotent', async () => {
  // The committed fixtures are already anonymized, so the second pass has a
  // zero delta and must be a byte-level no-op. That is what makes it safe to
  // run the scrub over the fixtures repeatedly.
  const input = await readFixture(ORIGINALS[2]);
  const once = anonymize(input).bytes;
  const twice = anonymize(once).bytes;
  assert.equal(firstDiff(once, twice), -1, 'anonymizing twice changed the file again');
});

test('anonymize reports only what it actually removed', async () => {
  // An already-clean file must claim nothing. The previous version counted a
  // redaction whenever the *field existed*, so the site showed a scissors list
  // promising a name, weight and resting heart rate had been stripped from
  // files that contained none of them -- the wrong direction to be wrong in
  // for a tool whose whole pitch is being straight about privacy.
  const clean = await readFixture(ORIGINALS[2]);
  assert.deepEqual(anonymize(clean).removed, [], 'claimed credit for work it did not do');

  // A file with real dates must report the rebase.
  const dirty = shiftAll(clean, 500_000_000);
  const { removed } = anonymize(dirty);
  assert.ok(
    removed.some((r) => /not recoverable/i.test(r)),
    'date rebase not reported',
  );
});

test('audit refuses to vouch for messages it does not know', async () => {
  // The old audit checked the same four fields the scrubber wrote, so it could
  // only ever agree with it -- it passed files holding a name, a device
  // address and the real session date. This one has to notice an unknown
  // message rather than stay quiet about it.
  const clean = await readFixture(ORIGINALS[1]);
  assert.deepEqual(audit(clean), [], 'a clean fixture should audit clean');

  // Relabel one kept message as an unknown global number and re-emit.
  const { header, frames } = readFit(clean);
  let relabelled = false;
  const out = frames.map((fr) => {
    if (fr.kind !== 'def' || fr.globalNum !== 21 || relabelled) return fr.bytes;
    relabelled = true;
    const b = new Uint8Array(fr.bytes);
    new DataView(b.buffer).setUint16(3, 9999, b[2] === 0);
    return b;
  });
  assert.ok(relabelled, 'setup failed to find an event definition');

  const problems = audit(writeFit(header, out));
  assert.ok(
    problems.some((p) => /9999/.test(p) && /keep-list/.test(p)),
    `an unknown message should be flagged, got: ${problems.join('; ')}`,
  );
});

/**
 * The fixtures rely on this. Golden files were produced by the Python
 * reference and then anonymized; that is only valid if anonymizing and
 * repairing commute. If this ever fails, the golden files stop meaning what
 * their comment claims and must be regenerated from unscrubbed originals.
 */
test('anonymize and repair commute', async () => {
  for (const name of ORIGINALS) {
    const input = await readFixture(name);

    const repairThenAnonymize = anonymize(repair(input).bytes).bytes;
    const anonymizeThenRepair = repair(anonymize(input).bytes).bytes;

    const d = firstDiff(repairThenAnonymize, anonymizeThenRepair);
    assert.equal(d, -1, `${name}: order of operations changed the output at byte ${d}`);
  }
});
