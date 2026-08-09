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
export const ORIGINALS = ['swim-01.fit', 'swim-02.fit', 'swim-03.fit', 'swim-04.fit'];

/**
 * Expected output of the Python reference, keyed by original.
 *
 * Two originals are deliberately absent:
 *
 *   swim-01  contains micro laps, from double-tapping the lap button, which
 *            only the one-off Python script merges. Its distance still comes
 *            out right; the lap structure differs. Covered by edgecases.
 *   swim-04  post-dates the reference implementation. Producing a golden for
 *            it would mean generating one with this codebase, which would make
 *            the comparison "JS agrees with JS" -- worthless. It earns its
 *            keep in the roundtrip, auto-lengths and anonymize suites instead.
 *
 * distanceM and lengths come from the calibration table in the handover and
 * were confirmed against the swimmer's own count.
 */
export const GOLDEN = {
  'swim-02.fit': { golden: 'swim-02_fixed.fit', distanceM: 900, lengths: 18 },
  'swim-03.fit': { golden: 'swim-03_fixed.fit', distanceM: 1000, lengths: 20 },
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
