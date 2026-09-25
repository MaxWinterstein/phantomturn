/**
 * The per-lap breakdown ("show the working") that analyze() hands the front
 * ends.
 *
 * It exists for one question: a swimmer looking at a repaired distance and not
 * sure it is right. That makes its only real obligation honesty -- a preview
 * that disagrees with the file it previews is worse than none, because it is
 * exactly what the swimmer will trust. So the central test is not about the
 * table's shape but that it predicts, lap by lap and in total, what repair()
 * then actually writes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze, repair } from '../src/swim-repair.js';
import { ORIGINALS, readFixture } from './fixtures.mjs';

const EPSILON = 1e-6;

for (const name of ORIGINALS) {
  test(`working: ${name} predicts the length count repair() writes`, async () => {
    const u8 = await readFixture(name);
    const info = analyze(u8);
    const { summary } = repair(u8);

    const promised = info.swimLaps.reduce((a, l) => a + l.target, 0);
    assert.equal(promised, summary.lengths, 'the preview must add up to the file');
  });
}

test('working: holds under a fixed lengths-per-lap as well as auto', async () => {
  // A fixed target is the case most likely to merge away real distance, and so
  // the one where the preview matters most.
  for (const name of ORIGINALS) {
    const u8 = await readFixture(name);
    for (const lengthsPerLap of [1, 2, 3]) {
      const opts = { lengthsPerLap };
      const promised = analyze(u8, opts).swimLaps.reduce((a, l) => a + l.target, 0);
      assert.equal(
        promised,
        repair(u8, opts).summary.lengths,
        `${name}, lengthsPerLap ${lengthsPerLap}`,
      );
    }
  }
});

test('working: each lap lists every recorded length, and they add up', async () => {
  for (const name of ORIGINALS) {
    for (const lap of analyze(await readFixture(name)).swimLaps) {
      const where = `${name} lap ${lap.lap + 1}`;
      assert.equal(lap.lengthsS.length, lap.lengths, `${where}: one duration per length`);
      assert.equal(lap.lengthStrokes.length, lap.lengths, `${where}: one stroke count per length`);

      const total = lap.lengthsS.reduce((a, s) => a + s, 0);
      assert.ok(Math.abs(total - lap.durS) < EPSILON, `${where}: durations sum to the lap`);
      const strokes = lap.lengthStrokes.reduce((a, s) => a + s, 0);
      assert.equal(strokes, lap.strokes, `${where}: strokes sum to the lap`);

      // Merging only ever goes down; nothing is split.
      assert.ok(lap.target >= 1 && lap.target <= lap.lengths, `${where}: 1 <= target <= recorded`);
    }
  }
});

test('working: a phantom split reads as fragments of one length', async () => {
  /*
   * swim-07's second lap is the fixture's one true phantom turn: the watch saw
   * two lengths of roughly half the inferred unit each. The breakdown has to
   * show both fragments and the merge, because that pairing -- two halves
   * against a one-length reference -- is what lets a swimmer see it was right.
   */
  const info = analyze(await readFixture('swim-07.fit'));
  const lap = info.swimLaps.find((l) => l.lengths > l.target);
  assert.ok(lap, 'swim-07 has one merged lap');
  assert.equal(lap.lengths, 2);
  assert.equal(lap.target, 1);
  for (const s of lap.lengthsS) {
    assert.ok(s < info.lengthUnitS * 0.75, `a fragment (${s}s) is well under one length`);
  }

  // And the genuine blocks are left alone, which is the other half of trusting it.
  const blocks = info.swimLaps.filter((l) => l.lengths > 1 && l.lengths === l.target);
  assert.deepEqual(
    blocks.map((l) => l.lengths),
    [3, 2],
    'the 3- and 2-length blocks from swimming through the turn survive',
  );
});
