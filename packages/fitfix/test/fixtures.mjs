/**
 * Test fixtures and shared helpers.
 *
 * Paths resolve through import.meta.url rather than the working directory, so
 * the suite runs from anywhere.
 *
 * All fixtures are scrubbed: no serial numbers, no user profile, no real
 * dates. See AGENTS.md before adding another one.
 */
import { readFile } from 'node:fs/promises';

/**
 * Garmin exports from a Forerunner 265 in a 50 m pool, anonymized.
 *
 * Named by sequence, not by their original filenames: a Garmin export is
 * called `<activityId>_ACTIVITY.fit`, and that id resolves to a real activity
 * on connect.garmin.com. The filename is personal data too.
 */
export const ORIGINALS = [
  'swim-01.fit',
  'swim-02.fit',
  'swim-03.fit',
  'swim-04.fit',
  'swim-05.fit',
  'swim-06.fit',
  'swim-07.fit',
  'swim-08.fit',
];

/**
 * swim-05 was swum in an **18 m pool that the watch had set to 20 m**, which
 * the swimmer reported afterwards. Nothing in the file reveals it -- every
 * duration and stroke count is self-consistent, only the metres are wrong --
 * so tests that care about distance must pass `poolLength: 18`. Left uncorrected
 * in the fixture on purpose: the wrongness is the thing worth testing.
 */
export const POOL_OVERRIDE = { 'swim-05.fit': 18 };

/**
 * Output of the Python reference, keyed by original.
 *
 * These are what `reference/repair_swim_fit.py` produces, regenerated from the
 * committed (already anonymized) inputs -- so the comparison is against an
 * independent implementation rather than against this codebase.
 *
 * IMPORTANT: the reference implements exactly one rule -- merge every active
 * length in a lap into one -- which is `lengthsPerLap: 1`. It has no notion of
 * 'auto'. So the comparison must run the JS in that mode, and `opts` below
 * says so explicitly rather than relying on a default that has since changed.
 * On swim-04 the two genuinely disagree: the reference gives 550 m, auto gives
 * 1100 m, and auto is the one that matches what the swimmer actually swam.
 *
 * swim-01 is deliberately absent: it also contains micro laps, from
 * double-tapping the lap button, which only a one-off variant of the script
 * merges. Its distance still comes out right; the lap structure differs. It is
 * covered by edgecases instead.
 *
 * distanceM and lengths are what the reference produces in that mode -- not
 * necessarily what was swum. The swimmer's confirmed counts live in
 * auto-lengths.test.mjs.
 */
/**
 * Everything the reference hardcodes, so the JS can be asked the same question
 * it answers. Anything the JS has since learned to do differently -- per-lap
 * length targets, thresholds that scale with pool size -- has to be pinned back
 * here, or the comparison silently becomes a comparison of two questions.
 *
 * `strokeSplit: 40` matters only for swim-05: at 50 m the scaled default works
 * out to exactly 40, so the older fixtures never noticed.
 */
const AS_REFERENCE = {
  lengthsPerLap: 1,
  strokeSplit: 40,
  durationSplit: 100,
  // The reference writes the stroke-count verdict even when it disagrees with
  // the duration; the JS now keeps the watch's label there by default.
  keepStrokeWhenUnsure: false,
};

export const GOLDEN = {
  'swim-02.fit': {
    golden: 'swim-02_fixed.fit',
    opts: AS_REFERENCE,
    distanceM: 900,
    lengths: 18,
  },
  'swim-03.fit': {
    golden: 'swim-03_fixed.fit',
    opts: AS_REFERENCE,
    distanceM: 1000,
    lengths: 20,
  },
  'swim-04.fit': {
    golden: 'swim-04_fixed.fit',
    opts: AS_REFERENCE,
    // The reference's answer, and wrong about this swim -- it cannot express
    // mixed lapping. Kept anyway: it still proves the two implementations
    // agree byte for byte when asked the same question.
    distanceM: 550,
    lengths: 11,
  },
  'swim-05.fit': {
    golden: 'swim-05_fixed.fit',
    opts: AS_REFERENCE,
    // 440 m because the reference trusts the file's 20 m pool. The swim was in
    // an 18 m pool, and how many lengths it really held is still open.
    distanceM: 440,
    lengths: 22,
  },
  'swim-06.fit': {
    golden: 'swim-06_fixed.fit',
    opts: AS_REFERENCE,
    // The reference folds all 63 recorded lengths down to 14, one per lap.
    // Badly wrong about this swim -- but that is its rule, and agreeing with
    // it byte for byte is the point.
    distanceM: 252,
    lengths: 14,
  },
  'swim-07.fit': {
    golden: 'swim-07_fixed.fit',
    opts: AS_REFERENCE,
    // The reference also folds the two genuine multi-length blocks (laps 17
    // and 21, ~85 s per length), losing 150 m. Auto keeps them and merges
    // only the true phantom split, giving the confirmed 850 m.
    distanceM: 700,
    lengths: 14,
  },
};

export const readFixture = async (name) =>
  new Uint8Array(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));

/** Offset of the first differing byte, or -1 when the two are identical. */
export function firstDiff(a, b) {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** Asserts byte equality with a useful message instead of a 100 kB diff. */
export function assertSameBytes(assert, actual, expected, what) {
  const d = firstDiff(actual, expected);
  assert.equal(
    d,
    -1,
    `${what}: differs at byte ${d} (${actual.length} vs ${expected.length} bytes)`,
  );
}
