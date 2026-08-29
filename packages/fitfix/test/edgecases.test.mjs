/**
 * Malformed input, idempotency, and the one fixture the general repair path
 * handles differently from the one-off Python script.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkIntegrity, getField, patchFrame, readFit, writeFit } from '../src/fit-patch.js';
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

test('a length with no recorded duration does not crash the repair', async () => {
  // A length whose total_elapsed_time and total_timer_time are both absent is
  // rare but legal, and the lap totals then divide by zero. patchFrame refuses
  // to write the resulting Infinity, so the whole file used to fail to open
  // with "field 17 in message 19: refusing to write Infinity".
  const MSG_LENGTH = 101;
  const LENGTH_TYPE_ACTIVE = 1;
  const [F_LENGTH_TYPE, F_ELAPSED, F_TIMER] = [12, 3, 4];

  const u8 = await readFixture('swim-03.fit');
  const { header, frames } = readFit(u8);

  let patched = false;
  const out = frames.map((f) => {
    if (
      !patched &&
      f.kind === 'data' &&
      f.globalNum === MSG_LENGTH &&
      getField(f, F_LENGTH_TYPE) === LENGTH_TYPE_ACTIVE
    ) {
      patched = true;
      return patchFrame(f, { [F_ELAPSED]: null, [F_TIMER]: null });
    }
    return f.bytes;
  });
  assert.ok(patched, 'fixture should contain at least one active length');

  const doctored = writeFit(header, out);
  assert.doesNotThrow(() => repair(doctored), 'zero-duration length should not throw');

  const { summary } = repair(doctored);
  assert.ok(Number.isFinite(summary.distanceM), 'distance stays finite');
});
