/**
 * The tunables in DEFAULTS actually doing something.
 *
 * lengthsPerLap in particular used to be a lie: analyze() reported against it
 * while repair() always merged down to one length regardless. These pin the
 * behaviour so it cannot quietly revert.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze, mergeToTarget, repair } from '../src/swim-repair.js';
import { firstDiff, ORIGINALS, readFixture } from './fixtures.mjs';

test('mergeToTarget collapses the shortest adjacent pair first', () => {
  // A phantom turn splits one length into two short halves, so the pair that
  // adds up to about one normal length is the one to merge.
  const durations = { 0: 110, 1: 55, 2: 55, 3: 108 };
  const durationOf = (k) => durations[k];

  assert.deepEqual(mergeToTarget([0, 1, 2, 3], 3, durationOf), [[0], [1, 2], [3]]);
  assert.deepEqual(mergeToTarget([0, 1, 2, 3], 1, durationOf), [[0, 1, 2, 3]]);

  // Never splits, only merges: asking for more than you have is a no-op.
  assert.deepEqual(mergeToTarget([0, 1], 5, durationOf), [[0], [1]]);
  assert.deepEqual(mergeToTarget([], 1, durationOf), []);

  // Groups stay contiguous and keep every index exactly once.
  const groups = mergeToTarget([0, 1, 2, 3], 2, durationOf);
  assert.deepEqual(groups.flat(), [0, 1, 2, 3]);
});

test('lengthsPerLap changes how much distance survives', async () => {
  const input = await readFixture(ORIGINALS[0]); // 12 laps, 9 active lengths

  const merged = repair(input, { lengthsPerLap: 1 }).summary;
  const kept = repair(input, { lengthsPerLap: 4 }).summary;

  assert.equal(merged.lengths, 4, 'default should merge down to one per lap');
  assert.equal(merged.distanceM, 200);

  // With a higher target nothing is merged away, so the watch's own count
  // survives. This is the setting an interval swimmer needs.
  assert.equal(kept.lengths, 9, 'a high target should merge nothing');
  assert.equal(kept.distanceM, 450);
});

test('strokeSplit moves the freestyle/breaststroke boundary', async () => {
  const input = await readFixture(ORIGINALS[1]);

  const low = analyze(input, { strokeSplit: 1 }).swimLaps;
  const high = analyze(input, { strokeSplit: 10_000 }).swimLaps;

  assert.ok(
    low.every((l) => l.stroke === 'breaststroke'),
    'everything should read as breaststroke below the split',
  );
  assert.ok(
    high.every((l) => l.stroke === 'freestyle'),
    'everything should read as freestyle above the split',
  );
});

test('reclassifyStroke and normalizeElapsed can both be turned off', async () => {
  const input = await readFixture(ORIGINALS[1]);

  const withStroke = repair(input, { reclassifyStroke: true }).bytes;
  const withoutStroke = repair(input, { reclassifyStroke: false }).bytes;
  assert.notEqual(firstDiff(withStroke, withoutStroke), -1, 'reclassifyStroke had no effect');

  const normalized = analyze(input, { normalizeElapsed: true }).findings;
  const asRecorded = analyze(input, { normalizeElapsed: false }).findings;
  const inflated = (fs) => fs.filter((f) => f.type === 'inflated-elapsed').length;
  assert.equal(inflated(normalized), 1, 'expected an inflated-elapsed finding');
  assert.equal(inflated(asRecorded), 0, 'normalizeElapsed:false should not report it');
});

test('durationSplit drives the ambiguous-stroke cross-check', async () => {
  const input = await readFixture(ORIGINALS[1]);
  const ambiguous = (opts) =>
    analyze(input, opts).findings.filter((f) => f.type === 'ambiguous-stroke').length;

  // Push the duration threshold far past every length: it then disagrees with
  // the stroke count on each breaststroke lap.
  assert.ok(ambiguous({ durationSplit: 10_000 }) > ambiguous({}), 'durationSplit had no effect');
});
