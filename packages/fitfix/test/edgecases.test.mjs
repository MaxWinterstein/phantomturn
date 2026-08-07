/**
 * Malformed input, idempotency, and the one fixture the general repair path
 * handles differently from the one-off Python script.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkIntegrity, readFit } from '../src/fit-patch.js';
import { analyze, repair } from '../src/swim-repair.js';
import { firstDiff, ORIGINALS, readFixture } from './fixtures.mjs';

const FILE_WITH_MICRO_LAPS = ORIGINALS[0];

test('file with micro laps: distance is corrected, lap structure is left alone', async () => {
  const u8 = await readFixture(FILE_WITH_MICRO_LAPS);
  const { bytes, info, summary } = repair(u8);

  // Confirmed by the swimmer: the watch reported 450 m over 9 lengths.
  assert.equal(summary.distanceM, 200, 'corrected distance');
  assert.equal(summary.lengths, 4, 'corrected length count');
  assert.ok(checkIntegrity(bytes), 'repaired file fails its integrity check');

  // The micro laps -- 0.9 s to 5.7 s, from double-tapping the lap button --
  // stay as they are. Merging them is still only solved in the Python script.
  assert.equal(info.swimLaps.length, 4, 'swim laps detected');
  const phantom = info.findings.filter((f) => f.type === 'phantom-turn');
  assert.equal(phantom.length, 4, 'phantom turns found');
});

test('malformed input is rejected with a clear error', async () => {
  const u8 = await readFixture(FILE_WITH_MICRO_LAPS);

  assert.throws(
    () => readFit(u8.subarray(0, 5000)),
    /data_size/,
    'a truncated file should be caught',
  );

  const badSignature = new Uint8Array(u8);
  badSignature[9] = 0x58;
  assert.throws(
    () => readFit(badSignature),
    /signature/,
    'a corrupted .FIT signature should be caught',
  );

  assert.throws(
    () => readFit(new Uint8Array(4)),
    /too short/,
    'a file shorter than a header should be caught',
  );

  // checkIntegrity reports rather than throws.
  assert.equal(checkIntegrity(badSignature), false);
});

test('repair is idempotent and rewrites the CRC', async () => {
  const u8 = await readFixture(FILE_WITH_MICRO_LAPS);
  const once = repair(u8).bytes;
  const twice = repair(once).bytes;

  assert.equal(firstDiff(once, twice), -1, 'repairing twice changed the file again');
  assert.notEqual(firstDiff(once, u8), -1, 'repair produced no change at all');

  // Changed payload must mean a changed trailing CRC.
  const crcChanged = once.at(-1) !== u8.at(-1) || once.at(-2) !== u8.at(-2);
  assert.ok(crcChanged, 'CRC was not recomputed');
});

test('analyze reports without modifying anything', async () => {
  const u8 = await readFixture(FILE_WITH_MICRO_LAPS);
  const before = new Uint8Array(u8);

  const info = analyze(u8);

  assert.equal(firstDiff(u8, before), -1, 'analyze mutated its input');
  assert.equal(info.poolM, 50, 'pool length');
  assert.ok(info.findings.length > 0, 'no findings on a file known to be broken');
  assert.ok(
    info.swimLaps.every((l) => l.durS > 0),
    'a swim lap with no duration',
  );
});
