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

// --- from review: the split file is not what the watch recorded -----------

/** swim-08 with its frames passed through `edit` (a frame -> patch map, or undefined). */
async function doctored(edit) {
  const { patchFrame, writeFit } = await import('../src/fit-patch.js');
  const { header, frames } = readFit(await readFixture('swim-08.fit'));
  const act = frames.filter(
    (f) => f.kind === 'data' && f.globalNum === MSG_LENGTH && getField(f, F_TYPE) === ACTIVE,
  );
  return writeFit(
    header,
    frames.map((f) => {
      const patch = edit(f, act);
      return patch ? patchFrame(f, patch) : f.bytes;
    }),
  );
}

const breaststrokes = (u8) => active(u8).filter((f) => getField(f, F_STROKE) !== 0).length;

test('split: never makes the stroke worse, whatever lengths per lap is', async () => {
  /*
   * The missed-turn guard is computed on the split file, where each half looks
   * like one ordinary length. A fixed target then merged the halves back and
   * the doubled stroke count read as breaststroke again: ticking "I remember
   * turning here" with lengths-per-lap 1 wrote four breaststroke lengths into
   * this all-freestyle swim, against three without it.
   */
  const u8 = await readFixture('swim-08.fit');
  for (const lengthsPerLap of ['auto', 1, 2, 3]) {
    const off = breaststrokes(repair(u8, { lengthsPerLap }).bytes);
    const on = breaststrokes(repair(u8, { lengthsPerLap, splitMissedTurns: true }).bytes);
    assert.ok(
      on <= off,
      `lengthsPerLap ${lengthsPerLap}: ${on} breaststroke with the split, ${off} without`,
    );
  }
});

test('split: says when a fixed target merges it straight back', async () => {
  // "Now split into 2" beside a distance that did not move is a claim the file
  // does not back; `gained` is what the page and CLI read to say so.
  const u8 = await readFixture('swim-08.fit');
  const gained = (opts) =>
    analyze(u8, { ...opts, splitMissedTurns: true }).findings.find((f) => f.type === 'missed-turn')
      .gained;
  assert.equal(gained({}), 1, 'auto: the split adds its length');
  assert.equal(gained({ lengthsPerLap: 1 }), 0, 'fixed 1: merged straight back');
  assert.equal(gained({ lengthsPerLap: 2 }), 0, 'fixed 2: merged straight back');
});

test('split: everything that reports the watch reports it as recorded', async () => {
  /*
   * Only the stat cards subtracted the made-up length at first. The Watch
   * column said 3 for a lap the watch recorded as 2, the lap-structure guard
   * said "24 lengths down to 16" beside a card saying the watch recorded 23,
   * and --dry-run counted 41 lengths in a 40-length file.
   */
  // Through both entry points: repair() runs its own copy of the pre-pass, and
  // the first version of this fix only threaded the recorded-index map through
  // analyze() -- which is what the tests used and the page does not.
  const u8 = await readFixture('swim-08.fit');
  const key = (await keyOf()).valueOf();
  for (const [via, run] of [
    ['analyze', (o) => analyze(u8, o)],
    ['repair', (o) => repair(u8, o).info],
  ])
    for (const lengthsPerLap of ['auto', 1]) {
      const off = run({ lengthsPerLap });
      const on = run({ lengthsPerLap, splitMissedTurns: [key] });
      assert.equal(on.lengths, off.lengths, `${via}, ${lengthsPerLap}: info.lengths`);
      assert.deepEqual(
        on.swimLaps.map((l) => l.recorded),
        off.swimLaps.map((l) => l.lengths),
        `${lengthsPerLap}: per-lap recorded counts`,
      );
      const pick = (i, type, field) =>
        i.findings.filter((f) => f.type === type).map((f) => f[field]);
      assert.deepEqual(pick(on, 'phantom-turn', 'detected'), pick(off, 'phantom-turn', 'detected'));
      assert.deepEqual(
        pick(on, 'lap-structure', 'lengthsBefore'),
        pick(off, 'lap-structure', 'lengthsBefore'),
      );
      assert.equal(on.madeUpLengths, 1);
    }
});

test('split: a length sharing the missed turn start second is left alone', async () => {
  // Keys were start times at first, and a start time is not unique.
  const u8 = await doctored((f, act) => {
    const missed = act.find((x) => Math.round(getField(x, F_ELAPSED) / 1000) === 151);
    return f === act[act.indexOf(missed) + 1]
      ? { [F_START]: getField(missed, F_START) }
      : undefined;
  });
  const lap = analyze(u8, { splitMissedTurns: true }).swimLaps.find((l) => l.lap === 11);
  assert.deepEqual(lap.split, [true, true, false], 'only the missed turn, not its neighbour');
});

test('split: keys stay put after another missed turn has been split', async () => {
  /*
   * The page ticks one, re-analyses the split file, and takes the next key
   * from that. Every later index of the split file is shifted by the made-up
   * length, so a key taken from it would point at the wrong length -- keys are
   * indices into the file as recorded.
   */
  const u8 = await doctored((f, act) =>
    f === act[act.length - 2] ? { [F_ELAPSED]: 160_000, 4: 160_000, [F_STROKES]: 56 } : undefined,
  );
  const keys = analyze(u8)
    .findings.filter((f) => f.type === 'missed-turn')
    .map((f) => f.key);
  assert.equal(keys.length, 2, 'the doctored file has two');
  const second = analyze(u8, { splitMissedTurns: [keys[0]] }).findings.find(
    (f) => f.type === 'missed-turn' && !f.split,
  );
  assert.equal(second.key, keys[1], 'the second key survives splitting the first');
  assert.deepEqual(
    repair(u8, { splitMissedTurns: [keys[0], second.key] }).bytes,
    repair(u8, { splitMissedTurns: true }).bytes,
  );
});

test('split: a part never goes negative, however few strokes there are', async () => {
  /*
   * From review. Non-last parts were rounded, so every one could round up and
   * leave the last with a negative remainder: 2 strokes in 4 parts came out as
   * 1, 1, 1 and -1. Written into an unsigned field, -1 is the invalid marker,
   * read back as 0, and total strokes rose from 2 to 3 -- exactly the "adds
   * nothing else" the split promises not to break. Needs a swim with about one
   * stroke per length, so it is doctored: every length 1 stroke, and one of
   * them four lengths long with 2.
   */
  const u8 = await doctored((f, act) => {
    if (!act.includes(f)) return undefined;
    return f === act[5] ? { [F_ELAPSED]: 320_000, 4: 320_000, [F_STROKES]: 2 } : { [F_STROKES]: 1 };
  });
  const found = analyze(u8).findings.find((f) => f.type === 'missed-turn');
  assert.ok(found, 'the doctored length reads as a missed turn');
  assert.ok(found.looksLike >= 3, `split into ${found.looksLike}, enough parts to round badly`);

  const sum = (b) => active(b).reduce((a, f) => a + (getField(f, F_STROKES) ?? 0), 0);
  const out = repair(u8, { splitMissedTurns: true }).bytes;
  assert.equal(sum(out), sum(repair(u8).bytes), 'total strokes unchanged');
  assert.ok(
    active(out).every((f) => getField(f, F_STROKES) !== null),
    'no part written as the invalid marker',
  );
});
