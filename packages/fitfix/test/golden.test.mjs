/**
 * Byte-for-byte comparison against the Python reference implementation.
 *
 * The golden files were produced by reference/repair_swim_fit.py, not by this
 * codebase, which is what makes this a cross-implementation check rather than
 * a tautology. Both sides were scrubbed with the same transform; that is sound
 * because repair() never writes a timestamp or an identity field, so scrubbing
 * and repairing commute. See tools/scrub-fixtures.mjs.
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

    const { bytes, summary } = repair(input);

    assertSameBytes(assert, bytes, want, 'repaired output');
    assert.ok(checkIntegrity(bytes), 'repaired file fails its integrity check');

    // The numbers the swimmer actually confirmed, not just whatever Python did.
    assert.equal(summary.distanceM, expected.distanceM, 'corrected distance');
    assert.equal(summary.lengths, expected.lengths, 'corrected length count');
  });
}
