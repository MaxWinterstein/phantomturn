/**
 * Working out lengths-per-lap from the file instead of being told.
 *
 * The numbers below are the swimmer's own confirmed counts, so this is the
 * closest thing the project has to ground truth. Every fixture is a different
 * shape of the same problem:
 *
 *   swim-01  every lap split, so no intact length exists anywhere to learn from
 *   swim-02  occasional splits among clean lengths, mixed strokes
 *   swim-03  the same, fewer splits
 *   swim-04  mixed lapping -- eight laps of one length, then blocks of 11 and 7
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze, repair } from '../src/swim-repair.js';
import { ORIGINALS, readFixture } from './fixtures.mjs';

/** Confirmed by the swimmer, not derived from the files. */
const TRUTH = {
  'swim-01.fit': { lengths: 4, distanceM: 200 },
  'swim-02.fit': { lengths: 18, distanceM: 900 },
  'swim-03.fit': { lengths: 20, distanceM: 1000 },
  'swim-04.fit': { lengths: 22, distanceM: 1100 },
};

for (const [name, want] of Object.entries(TRUTH)) {
  test(`auto recovers the confirmed count for ${name}`, async () => {
    const input = await readFixture(name);
    const { summary } = repair(input, { lengthsPerLap: 'auto' });
    assert.equal(summary.lengths, want.lengths, 'length count');
    assert.equal(summary.distanceM, want.distanceM, 'distance');
  });
}

test('auto sees through a file where every length was split', async () => {
  // swim-01 is the hard case for learning from recorded lengths: not one
  // intact length exists in it, so the unit has to come from the lap totals.
  const input = await readFixture('swim-01.fit');
  const info = analyze(input, { lengthsPerLap: 'auto' });

  const swimLaps = info.swimLaps;
  assert.equal(swimLaps.length, 4, 'four swim laps');
  assert.ok(
    swimLaps.every((l) => l.lengths > 1),
    'setup: every lap should hold multiple recorded lengths',
  );
  for (const l of swimLaps) {
    assert.equal(info.lapTargets[l.lap], 1, `lap ${l.lap} should resolve to one real length`);
  }
});

test('auto reports the unit it inferred', async () => {
  const input = await readFixture('swim-02.fit');
  const info = analyze(input, { lengthsPerLap: 'auto' });

  assert.ok(info.lengthUnitS > 0, 'no unit inferred');
  // A 50 m length for this swimmer runs 70-155 s depending on stroke.
  assert.ok(
    info.lengthUnitS > 60 && info.lengthUnitS < 200,
    `implausible unit ${info.lengthUnitS}`,
  );
  assert.equal(info.lapTargets.length, info.lapLengths.length, 'one target per lap');
});

test('auto resolves each lap separately when the lapping was inconsistent', async () => {
  /*
   * swim-04 is the file the whole feature exists for: eight laps of one length
   * each, then a continuous block of eleven, then one of seven. No single
   * number describes it -- a fixed 1 turns 1350 m into 550 m, and a fixed 11
   * merges nothing at all.
   */
  const input = await readFixture('swim-04.fit');
  const info = analyze(input, { lengthsPerLap: 'auto' });

  const swimTargets = info.swimLaps.map((l) => info.lapTargets[l.lap]);
  assert.ok(new Set(swimTargets).size > 1, 'targets should differ between laps');
  assert.deepEqual(
    swimTargets.filter((n) => n > 1).sort((a, b) => b - a),
    [9, 4],
    'block sizes',
  );

  // Both dead ends a fixed number leads to.
  assert.equal(repair(input, { lengthsPerLap: 1 }).summary.distanceM, 550);
  assert.equal(repair(input, { lengthsPerLap: 11 }).summary.distanceM, 1350);
  assert.equal(repair(input, { lengthsPerLap: 'auto' }).summary.distanceM, 1100);
});

test('a fixed number still overrides auto', async () => {
  const input = await readFixture('swim-01.fit');

  assert.equal(repair(input, { lengthsPerLap: 'auto' }).summary.lengths, 4);
  // Explicitly asking for no merging must still mean no merging.
  assert.equal(repair(input, { lengthsPerLap: 9 }).summary.lengths, 9);
});

test('auto never invents lengths the watch did not record', async () => {
  // It merges, it never splits, so a missed turn stays missed -- the estimate
  // is always capped at the recorded count.
  for (const name of ORIGINALS) {
    const input = await readFixture(name);
    const info = analyze(input, { lengthsPerLap: 'auto' });
    info.lapLengths.forEach((ids, li) => {
      assert.ok(
        info.lapTargets[li] <= Math.max(1, ids.length),
        `${name} lap ${li}: target ${info.lapTargets[li]} exceeds ${ids.length} recorded`,
      );
    });
  }
});
