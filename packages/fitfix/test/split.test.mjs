/**
 * Splitting a missed turn: the one place this tool adds a length.
 *
 * Everywhere else it only merges, so every number it writes is one the watch
 * measured. A split has to make two up -- where the turn fell, and how the
 * strokes divide -- so it is off by default, opt-in per length, and these
 * tests hold it to the narrowest thing it can honestly claim: that it
 * redistributes what was recorded, and adds nothing else. Total time and total
 * strokes are unchanged; only the count of lengths, and so the distance, moves.
 *
 * swim-08's truth is confirmed by the swimmer: 22 lengths, 1100 m, freestyle.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { anonymize } from '../src/anonymize.js';
import { checkIntegrity, getField, readFit } from '../src/fit-patch.js';
import { analyze, repair } from '../src/swim-repair.js';
import { ORIGINALS, POOL_OVERRIDE, readFixture } from './fixtures.mjs';

const MSG_LENGTH = 101;
const [F_START, F_ELAPSED, F_STROKES, F_TYPE, F_STROKE] = [2, 3, 5, 12, 7];
const ACTIVE = 1;

const active = (u8) =>
  readFit(u8)
    .frames.filter((f) => f.kind === 'data' && f.globalNum === MSG_LENGTH)
    .filter((f) => getField(f, F_TYPE) === ACTIVE);

const keyOf = async () =>
  analyze(await readFixture('swim-08.fit')).findings.find((f) => f.type === 'missed-turn').key;

test('split: off unless asked for', async () => {
  const u8 = await readFixture('swim-08.fit');
  assert.equal(repair(u8).summary.lengths, 21, 'the default still writes what the watch recorded');
  assert.deepEqual(repair(u8, { splitMissedTurns: false }).bytes, repair(u8).bytes);
});

test('split: swim-08 comes out at the confirmed 1100 m', async () => {
  const { summary, bytes, info } = repair(await readFixture('swim-08.fit'), {
    splitMissedTurns: true,
  });
  assert.equal(summary.lengths, 22);
  assert.equal(summary.distanceM, 1100);
  assert.ok(checkIntegrity(bytes), 'a valid FIT file');
  assert.ok(
    active(bytes).every((f) => getField(f, F_STROKE) === 0),
    'still freestyle throughout',
  );

  // The finding survives, marked, so the switch that turned it on stays.
  const f = info.findings.filter((x) => x.type === 'missed-turn');
  assert.equal(f.length, 1);
  assert.equal(f[0].split, true);
});

test('split: redistributes what was recorded and adds nothing else', async () => {
  const u8 = await readFixture('swim-08.fit');
  const before = active(u8);
  const after = active(repair(u8, { splitMissedTurns: true }).bytes);
  const plain = active(repair(u8).bytes);

  const sum = (frames, field) => frames.reduce((a, f) => a + (getField(f, field) ?? 0), 0);
  assert.equal(sum(after, F_STROKES), sum(plain, F_STROKES), 'total strokes unchanged');
  assert.equal(sum(after, F_ELAPSED), sum(plain, F_ELAPSED), 'total swim time unchanged');

  // The two parts, exactly: halves of the original, back to back, in order.
  const original = before.find((f) => Math.round(getField(f, F_ELAPSED) / 1000) === 151);
  const i = after.findIndex((f) => getField(f, F_START) === getField(original, F_START));
  const [a, b] = [after[i], after[i + 1]];
  assert.equal(getField(a, F_ELAPSED) + getField(b, F_ELAPSED), getField(original, F_ELAPSED));
  assert.equal(getField(a, F_STROKES) + getField(b, F_STROKES), getField(original, F_STROKES));
  assert.ok(Math.abs(getField(a, F_ELAPSED) - getField(b, F_ELAPSED)) <= 1, 'split halfway');
  assert.equal(
    getField(b, F_START),
    getField(a, F_START) + Math.round(getField(a, F_ELAPSED) / 1000),
    'the second starts where the first ends',
  );
});

test('split: the made-up lengths are marked as made up', async () => {
  // The page and the CLI both tag them; this is where that flag comes from.
  const info = analyze(await readFixture('swim-08.fit'), { splitMissedTurns: true });
  const lap = info.swimLaps.find((l) => l.lap === 11);
  assert.deepEqual(lap.split, [true, true, false], 'the two halves, not the real 97 s length');
  assert.equal(
    info.swimLaps.flatMap((l) => l.split).filter(Boolean).length,
    2,
    'and nothing else in the swim',
  );
});

test('split: chosen by key, one length at a time', async () => {
  const u8 = await readFixture('swim-08.fit');
  const all = repair(u8, { splitMissedTurns: true }).bytes;
  assert.deepEqual(repair(u8, { splitMissedTurns: [await keyOf()] }).bytes, all);
  assert.deepEqual(
    repair(u8, { splitMissedTurns: [123] }).bytes,
    repair(u8).bytes,
    'a key that matches nothing splits nothing',
  );
});

test('split: the working table still adds up to the file', async () => {
  const u8 = await readFixture('swim-08.fit');
  for (const lengthsPerLap of ['auto', 1, 2]) {
    const opts = { splitMissedTurns: true, lengthsPerLap };
    const promised = analyze(u8, opts).swimLaps.reduce((a, l) => a + l.target, 0);
    assert.equal(promised, repair(u8, opts).summary.lengths, `lengthsPerLap ${lengthsPerLap}`);
  }
});

test('split: repairing the output again changes nothing', async () => {
  const once = repair(await readFixture('swim-08.fit'), { splitMissedTurns: true });
  const twice = repair(once.bytes, { splitMissedTurns: true });
  assert.equal(twice.summary.lengths, once.summary.lengths);
  assert.equal(twice.summary.distanceM, once.summary.distanceM);
});

test('split: files without a missed turn come out byte-identical', async () => {
  for (const name of ORIGINALS.filter((n) => n !== 'swim-08.fit')) {
    const u8 = await readFixture(name);
    const pool = POOL_OVERRIDE[name] ? { poolLength: POOL_OVERRIDE[name] } : {};
    assert.deepEqual(
      repair(u8, { ...pool, splitMissedTurns: true }).bytes,
      repair(u8, pool).bytes,
      name,
    );
  }
});

test('split: commutes with anonymizing, like the rest of the repair', async () => {
  // The fixture is already anonymized, so this checks the split's timestamps
  // are relative -- a start time the dates' rebase would not carry along.
  const u8 = await readFixture('swim-08.fit');
  const opts = { splitMissedTurns: true };
  assert.deepEqual(
    anonymize(repair(u8, opts).bytes).bytes,
    repair(anonymize(u8).bytes, opts).bytes,
  );
});
