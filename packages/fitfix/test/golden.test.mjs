/**
 * Byte-for-byte comparison against the Python reference implementation.
 *
 * The golden files were produced by reference/repair_swim_fit.py, not by this
 * codebase, which is what makes this a cross-implementation check rather than
 * a tautology. Both sides are the anonymized fixtures; that is sound because
 * repair() never writes a timestamp or an identity field, so anonymizing and
 * repairing commute -- and regenerating the goldens from the committed inputs
 * reproduces them byte for byte, which demonstrates it.
 *
 * The reference implements one rule: merge every active length in a lap into
 * one. It has no notion of 'auto', so the JS is run in that mode here. Where
 * the two now disagree -- swim-04, the mixed-lapping file -- the disagreement
 * is deliberate and is pinned in auto-lengths.test.mjs against the swimmer's
 * confirmed count.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkIntegrity } from '../src/fit-patch.js';
import { repair } from '../src/swim-repair.js';
import { assertSameBytes, GOLDEN, readFixture } from './fixtures.mjs';

for (const [src, expected] of Object.entries(GOLDEN)) {
  test(`golden: ${src} matches the Python reference`, async () => {
    const input = await readFixture(src);
    const want = await readFixture(expected.golden);

    const { bytes, summary } = repair(input, expected.opts);

    assertSameBytes(assert, bytes, want, 'repaired output');
    assert.ok(checkIntegrity(bytes), 'repaired file fails its integrity check');

    assert.equal(summary.distanceM, expected.distanceM, 'corrected distance');
    assert.equal(summary.lengths, expected.lengths, 'corrected length count');
  });
}

test('the reference and auto disagree about swim-04, on purpose', async () => {
  /*
   * The one file where the two implementations part company. The reference
   * cannot express mixed lapping -- eight laps of one length, then blocks of
   * eleven and seven -- so it folds each lap to one and reports 550 m. The
   * swimmer swam 1100 m.
   *
   * Asserted rather than left implicit: if these ever converge, either auto
   * regressed to a fixed rule or the reference grew a feature, and both are
   * things someone should have to notice deliberately.
   */
  const input = await readFixture('swim-04.fit');

  assert.equal(repair(input, { lengthsPerLap: 1 }).summary.distanceM, 550, 'reference behaviour');
  assert.equal(repair(input).summary.distanceM, 1100, 'auto, the default');
});
