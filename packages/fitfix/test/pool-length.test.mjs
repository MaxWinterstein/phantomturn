/**
 * A pool the watch had the wrong size for.
 *
 * swim-05 was swum in an 18 m pool with the watch set to 20 m. This is the one
 * error the file cannot betray on its own: every duration and stroke count is
 * internally consistent, and only the metres are wrong -- by a fixed ratio. So
 * it can only come from the swimmer, and once it does it has to reach the
 * thresholds as well as the distances.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getField, readFit } from '../src/fit-patch.js';
import { analyze, repair } from '../src/swim-repair.js';
import { POOL_OVERRIDE, readFixture } from './fixtures.mjs';

const FILE = 'swim-05.fit';
const REAL_POOL = POOL_OVERRIDE[FILE];

const sessionField = (u8, num) => {
  const frame = readFit(u8).frames.find((f) => f.kind === 'data' && f.globalNum === 18);
  return getField(frame, num);
};

test('the override scales the distance and is written into the output', async () => {
  const input = await readFixture(FILE);
  assert.equal(sessionField(input, 44) / 100, 20, 'setup: the file should still say 20 m');

  const asRecorded = repair(input);
  const corrected = repair(input, { poolLength: REAL_POOL });

  // Same lengths, distance scaled by 18/20.
  assert.equal(corrected.summary.lengths, asRecorded.summary.lengths);
  assert.equal(
    corrected.summary.distanceM,
    Math.round((asRecorded.summary.distanceM * REAL_POOL) / 20),
    'distance should scale with the pool',
  );

  // And the file must say 18 afterwards, or anything that recomputes from
  // pool_length will disagree with the totals sitting next to it.
  assert.equal(sessionField(corrected.bytes, 44) / 100, REAL_POOL, 'pool_length not rewritten');
  assert.equal(sessionField(asRecorded.bytes, 44) / 100, 20, 'left alone without an override');
});

test('the stroke thresholds scale with the pool, not with the fixture', async () => {
  const input = await readFixture(FILE);

  const auto = analyze(input, { poolLength: REAL_POOL });
  // 80 strokes per 100 m -> 14.4 in an 18 m pool. A fixed 40, calibrated at
  // 50 m, is unreachable here: every length read as freestyle, including the
  // ones the watch had correctly called breaststroke.
  assert.ok(auto.strokeSplit > 14 && auto.strokeSplit < 15, `got ${auto.strokeSplit}`);
  assert.ok(auto.durationSplit > 35 && auto.durationSplit < 37, `got ${auto.durationSplit}`);

  const fixed = analyze(input, { poolLength: REAL_POOL, strokeSplit: 40 });
  assert.equal(fixed.strokeSplit, 40, 'an explicit number must win');

  // At 50 m the scaled default lands exactly on the old constant, which is why
  // the older fixtures never noticed the change.
  const fifty = analyze(await readFixture('swim-02.fit'));
  assert.equal(fifty.strokeSplit, 40);
  assert.equal(fifty.durationSplit, 100);
});

test('a nonsense override is ignored rather than obeyed', async () => {
  const input = await readFixture(FILE);
  for (const bad of [0, -18, Number.NaN, 'eighteen', null]) {
    assert.equal(analyze(input, { poolLength: bad }).poolM, 20, `poolLength: ${String(bad)}`);
  }
});

test('the two length readings are reported rather than one being picked', async () => {
  /*
   * This file is where the unit estimator runs out of signal. Total active
   * time and total strokes both independently say about 64 lengths, but the
   * median lap total says 46 s per length, which implies 47. The data does not
   * settle it, so both readings have to reach the user.
   */
  const input = await readFixture(FILE);
  const info = analyze(input, { poolLength: REAL_POOL });

  const uncertain = info.findings.find((f) => f.type === 'uncertain-lengths');
  assert.ok(uncertain, 'no uncertain-lengths finding');
  assert.notEqual(uncertain.chosenLengths, uncertain.alternateLengths, 'both readings the same');
  assert.ok(uncertain.chosenUnitS > 0 && uncertain.alternateUnitS > 0, 'a unit is missing');
  assert.match(uncertain.note, /does not settle it/);

  // The chosen reading is the one from the more uniform set. Here that is the
  // recorded lengths, which keeps far more of the swim than the lap totals
  // would -- the direction that matters, since the alternative deletes real
  // distance rather than merely leaving phantom turns in.
  assert.ok(
    uncertain.chosenLengths > uncertain.alternateLengths,
    `chose ${uncertain.chosenLengths} over ${uncertain.alternateLengths}`,
  );
});
