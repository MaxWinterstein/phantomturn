/**
 * Refusing to produce a plausible-looking wrong answer.
 *
 * Every case here used to succeed quietly and hand back a valid FIT file with
 * data missing or invented, which is worse than an error: the file passes its
 * own integrity check, so nothing downstream notices.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getField, hasField, patchFrame, readFit, writeFit } from '../src/fit-patch.js';
import { analyze, repair } from '../src/swim-repair.js';
import { ORIGINALS, readFixture } from './fixtures.mjs';

const MSG = { session: 18, lap: 19, length: 101 };

/** Rebuilds a file with a transform applied to matching data frames. */
function rewrite(u8, globalNum, transform) {
  const { header, frames } = readFit(u8);
  let seen = 0;
  const out = frames.map((fr) => {
    if (fr.kind !== 'data' || fr.globalNum !== globalNum) return fr.bytes;
    const patch = transform(fr, seen++);
    return patch ? patchFrame(fr, patch) : fr.bytes;
  });
  return writeFit(header, out);
}

/** Drops every data frame of a given type. */
function dropAll(u8, globalNum) {
  const { header, frames } = readFit(u8);
  return writeFit(
    header,
    frames.filter((fr) => fr.kind !== 'data' || fr.globalNum !== globalNum).map((fr) => fr.bytes),
  );
}

test('a length belonging to no lap is refused, not deleted', async () => {
  const input = await readFixture(ORIGINALS[1]);
  assert.equal(repair(input).summary.lengths, 18, 'baseline');

  // One length with an invalid start_time matches no lap window. This used to
  // drop the length and quietly return 850 m instead of 900 m.
  const orphaned = rewrite(input, MSG.length, (_fr, i) => (i === 3 ? { 2: null } : null));
  assert.throws(() => analyze(orphaned), /belong to no lap/);
  assert.throws(() => repair(orphaned), /belong to no lap/);
});

test('a file with no laps is refused, not emptied', async () => {
  const input = await readFixture(ORIGINALS[1]);
  const lapless = dropAll(input, MSG.lap);

  // Previously every length was dropped and the result was a clean,
  // integrity-valid, 0 m activity.
  assert.throws(() => repair(lapless), /belong to no lap/);
});

test('out-of-order laps are refused rather than double-counted', async () => {
  const input = await readFixture(ORIGINALS[1]);

  // Swapping two lap start times makes the windows overlap, so a length lands
  // in two laps: counted twice in the totals, emitted once, and the
  // message_index sequence comes out with holes in it.
  const starts = [];
  readFit(input).frames.forEach((fr) => {
    if (fr.kind === 'data' && fr.globalNum === MSG.lap) starts.push(getField(fr, 2));
  });
  const swapped = rewrite(input, MSG.lap, (_fr, i) => {
    if (i === 4) return { 2: starts[6] };
    if (i === 6) return { 2: starts[4] };
    return null;
  });

  assert.throws(() => repair(swapped), /not in order|belong to no lap/);
});

test('a swim with no strokes recorded leaves derived fields invalid, not zero', async () => {
  const input = await readFixture(ORIGINALS[1]);

  // A kick set: lengths and durations, but total_strokes zero throughout.
  // distCm / 0 is Infinity, and patchFrame coerces that to 0 through
  // DataView -- so the file used to claim a real "0 m per stroke".
  const noStrokes = rewrite(input, MSG.length, (fr) => (hasField(fr, 5) ? { 5: 0 } : null));

  const { bytes, summary } = repair(noStrokes);
  assert.equal(summary.strokes, 0);
  assert.equal(summary.distanceM, 900, 'distance should survive a kick set');

  const session = readFit(bytes).frames.find(
    (f) => f.kind === 'data' && f.globalNum === MSG.session,
  );
  const strokeDistance = getField(session, 42);
  assert.ok(
    strokeDistance === null || strokeDistance === 0,
    `avg_stroke_distance should be invalid or zero, got ${strokeDistance}`,
  );
  assert.ok(Number.isFinite(getField(session, 124)), 'avg_speed should still be a real number');
});

test('lap-structure warns about a fixed target, not about auto', async () => {
  const input = await readFixture(ORIGINALS[0]); // 4 laps, every one split

  const fires = (opts) => analyze(input, opts).findings.some((f) => f.type === 'lap-structure');

  assert.equal(fires({ lengthsPerLap: 1 }), true, 'should fire on a fixed target of 1');
  // With a target high enough that no lap exceeds it, no distance is lost, so
  // the red "22 lengths would become 22" warning had no business appearing.
  assert.equal(fires({ lengthsPerLap: 20 }), false, 'fired when nothing would be merged');
  // The warning says "your setting may be wrong". auto has no setting to be
  // wrong about -- it measures each lap on its own.
  assert.equal(fires({}), false, 'auto should not warn about its own choice');
});
