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

test('mergeToTarget produces the most even grouping, not a greedy one', () => {
  const of = (table) => (k) => table[k];

  // The case the old greedy rule got wrong: two real lengths, both split by a
  // phantom turn. Merging the smallest adjacent pair (25+25) straddles the
  // true boundary and every later merge inherits that mistake.
  assert.deepEqual(mergeToTarget([0, 1, 2, 3], 2, of([30, 25, 25, 30])), [
    [0, 1],
    [2, 3],
  ]);

  // One split length among whole ones -- the halves still pair up.
  assert.deepEqual(mergeToTarget([0, 1, 2, 3], 3, of([110, 55, 55, 108])), [[0], [1, 2], [3]]);
  assert.deepEqual(mergeToTarget([0, 1, 2, 3], 2, of([110, 55, 55, 108])), [
    [0, 1],
    [2, 3],
  ]);

  assert.deepEqual(mergeToTarget([0, 1, 2, 3], 1, of([110, 55, 55, 108])), [[0, 1, 2, 3]]);

  // Never splits: asking for more groups than you have is a no-op.
  assert.deepEqual(mergeToTarget([0, 1], 5, of([1, 1])), [[0], [1]]);
  assert.deepEqual(mergeToTarget([], 1, of([])), []);

  // A non-numeric target means "merge everything" rather than silently
  // disabling the merge, which is what NaN used to do.
  assert.deepEqual(mergeToTarget([0, 1, 2], Number.NaN, of([1, 1, 1])), [[0, 1, 2]]);
  assert.deepEqual(mergeToTarget([0, 1, 2], undefined, of([1, 1, 1])), [[0, 1, 2]]);

  // Contiguous, every index exactly once, in order.
  const groups = mergeToTarget([0, 1, 2, 3, 4], 3, of([9, 1, 8, 2, 7]));
  assert.deepEqual(groups.flat(), [0, 1, 2, 3, 4]);
  assert.equal(groups.length, 3);
});

test('mergeToTarget stays fast on a pathological lap', () => {
  // The default target short-circuits, so the common path is linear however
  // many lengths a crafted file crams into one lap. Above the search bound it
  // falls back to equal chunks rather than blocking the main thread.
  const of = (k) => (k % 7) + 1;

  const started = performance.now();
  const single = mergeToTarget([...Array(20_000).keys()], 1, of);
  const elapsed = performance.now() - started;

  assert.equal(single.length, 1);
  assert.equal(single[0].length, 20_000);
  assert.ok(elapsed < 250, `20k lengths took ${elapsed.toFixed(0)}ms`);

  const chunked = mergeToTarget([...Array(5_000).keys()], 4, of);
  assert.equal(chunked.length, 4);
  assert.equal(chunked.flat().length, 5_000);
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
