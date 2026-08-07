/**
 * The load-bearing property of this project: reading a file and writing it
 * back without changes returns the exact same bytes.
 *
 * If this ever fails, the byte-patch approach is broken and every other
 * guarantee goes with it -- a file that survives a no-op roundtrip is a file
 * whose unknown messages and manufacturer fields we are not destroying.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkIntegrity, readFit, writeFit } from '../src/fit-patch.js';
import { assertSameBytes, ORIGINALS, readFixture } from './fixtures.mjs';

for (const name of ORIGINALS) {
  test(`roundtrip: ${name} is unchanged by read + write`, async () => {
    const u8 = await readFixture(name);
    assert.ok(checkIntegrity(u8), 'fixture fails its own integrity check');

    const { header, frames } = readFit(u8);
    assert.ok(frames.length > 0, 'no frames parsed');
    assert.ok(
      frames.some((f) => f.kind === 'def'),
      'no definition messages parsed',
    );

    const back = writeFit(
      header,
      frames.map((fr) => fr.bytes),
    );
    assertSameBytes(assert, back, u8, 'no-op roundtrip');
  });
}
