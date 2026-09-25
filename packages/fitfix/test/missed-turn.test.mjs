/**
 * Missed turns: two lengths the watch recorded as one.
 *
 * The other direction from a phantom turn, and the one this tool cannot fix --
 * it merges, it never splits, because splitting means inventing a turn time and
 * a stroke split the watch never recorded. What it can do is notice, say so,
 * and not make the file worse. Before this, it did neither: swim-08 came out
 * 50 m short with nothing said, and the length's doubled stroke count was read
 * as breaststroke and *written* into a swim that was freestyle throughout.
 *
 * swim-08's truth is confirmed by the swimmer: all freestyle, 22 lengths,
 * 1100 m. Lap 12 was three lengths recorded as two, one of them 151 s with 51
 * strokes against a unit of ~79 s and a median of ~28 strokes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { getField, readFit } from '../src/fit-patch.js';
import { analyze, repair } from '../src/swim-repair.js';
import { POOL_OVERRIDE, readFixture } from './fixtures.mjs';

const MSG_LENGTH = 101;
const [F_TYPE, F_STROKE] = [12, 7];
const [ACTIVE, FREESTYLE] = [1, 0];

const activeStrokes = (u8) =>
  readFit(u8)
    .frames.filter((f) => f.kind === 'data' && f.globalNum === MSG_LENGTH)
    .filter((f) => getField(f, F_TYPE) === ACTIVE)
    .map((f) => getField(f, F_STROKE));

test('missed turn: swim-08 reports exactly the one it has', async () => {
  const info = analyze(await readFixture('swim-08.fit'));
  const missed = info.findings.filter((f) => f.type === 'missed-turn');
  assert.equal(missed.length, 1);
  assert.equal(missed[0].lap + 1, 12, 'lap 12, as the swimmer said');
  assert.equal(missed[0].looksLike, 2);
  assert.equal(Math.round(missed[0].durS), 151);

  const lap = info.swimLaps.find((l) => l.lap === missed[0].lap);
  assert.deepEqual(lap.missedTurns, [true, false], 'the 151 s length, not the 97 s one');
});

test('missed turn: the report accounts for the shortfall exactly', async () => {
  /*
   * The repaired file is still short -- that is the point of reporting rather
   * than fixing -- but what it writes plus what it reports as missing has to
   * come to the confirmed truth. If it does not, the finding is noise.
   */
  const u8 = await readFixture('swim-08.fit');
  const { summary, info } = repair(u8);
  const reportedMissing = info.findings
    .filter((f) => f.type === 'missed-turn')
    .reduce((a, f) => a + f.looksLike - 1, 0);

  assert.equal(summary.lengths, 21, 'still one short: nothing is split');
  assert.equal(summary.lengths + reportedMissing, 22, 'confirmed: 22 lengths');
  assert.equal((summary.lengths + reportedMissing) * info.poolM, 1100, 'confirmed: 1100 m');
});

test('missed turn: its stroke is left as the watch said', async () => {
  // 51 strokes in "one length" clears the breaststroke threshold, so the
  // classifier used to write breaststroke into an all-freestyle swim.
  const u8 = await readFixture('swim-08.fit');
  assert.ok(
    activeStrokes(u8).every((s) => s === FREESTYLE),
    'the watch said freestyle throughout',
  );

  const { bytes, info } = repair(u8);
  assert.ok(
    activeStrokes(bytes).every((s) => s === FREESTYLE),
    'and the repaired file still does',
  );
  assert.equal(
    info.findings.filter((f) => f.type === 'stroke-mismatch').length,
    0,
    'no stroke finding about an artefact of the missed turn',
  );
});

test('missed turn: none of the other fixtures trip it', async () => {
  /*
   * The threshold sits between swim-08's 1.92x and the 1.61x an 18 m pool
   * reaches on its own. This is the test that would fail first if it were
   * lowered to the tempting "rounds to two lengths" at 1.5x.
   */
  for (let n = 1; n <= 7; n++) {
    const name = `swim-0${n}.fit`;
    const pool = POOL_OVERRIDE[name] ? { poolLength: POOL_OVERRIDE[name] } : {};
    for (const lengthsPerLap of ['auto', 1, 2]) {
      const found = analyze(await readFixture(name), { ...pool, lengthsPerLap }).findings.filter(
        (f) => f.type === 'missed-turn',
      );
      assert.equal(found.length, 0, `${name}, lengthsPerLap ${lengthsPerLap}`);
    }
  }
});

test('missed turn: still detected when lengths per lap is a fixed number', async () => {
  // How the lap button was pressed has nothing to do with a missed turn, so a
  // fixed target must not switch the check off.
  const info = analyze(await readFixture('swim-08.fit'), { lengthsPerLap: 1 });
  assert.equal(info.findings.filter((f) => f.type === 'missed-turn').length, 1);
});

test('unsure strokes keep the watch label by default, and not as the reference', async () => {
  /*
   * The page has always said an ambiguous stroke keeps the watch's label. It
   * did not: in swim-04 lap 17 and swim-05 lap 1 the watch said breaststroke
   * and the repair wrote freestyle. keepStrokeWhenUnsure makes the promise
   * true; turning it off reproduces the Python reference, which is how the
   * goldens stay byte-exact.
   */
  for (const [name, opts, lap] of [
    ['swim-04.fit', {}, 17],
    ['swim-05.fit', { poolLength: 18 }, 1],
  ]) {
    const u8 = await readFixture(name);
    const info = analyze(u8, opts);
    const decided = [...info.strokeWrite.entries()];
    const firstOfLap = new Set(info.lapLengths[lap - 1]);
    const kept = decided.filter(([k, s]) => firstOfLap.has(k) && s === null);
    assert.ok(kept.length >= 1, `${name} lap ${lap}: an ambiguous group keeps the watch label`);

    const asReference = analyze(u8, { ...opts, keepStrokeWhenUnsure: false });
    const forced = [...asReference.strokeWrite.entries()].filter(
      ([k, s]) => firstOfLap.has(k) && s === null,
    );
    assert.equal(forced.length, 0, `${name} lap ${lap}: the reference overwrites it`);
  }
});

test('missed turn: a long length without the strokes to match is not one', async () => {
  /*
   * Duration alone is not enough. A kick set, or a pause at the wall without
   * pressing lap, makes a length run long with an ordinary or near-zero stroke
   * count -- and that is one length, not two. No fixture has one, so without
   * this test the stroke half of the rule could be deleted and every test
   * above would still pass; this doctors one into swim-07.
   */
  const { patchFrame, writeFit } = await import('../src/fit-patch.js');
  const [F_ELAPSED, F_TIMER, F_STROKES] = [3, 4, 5];
  const { header, frames } = readFit(await readFixture('swim-07.fit'));

  let doctored = false;
  const out = frames.map((f) => {
    if (
      !doctored &&
      f.kind === 'data' &&
      f.globalNum === MSG_LENGTH &&
      getField(f, F_TYPE) === ACTIVE
    ) {
      doctored = true;
      // 200 s is ~2.5 lengths at swim-07's ~81 s unit -- well past the ratio --
      // while its strokes stay one length's worth. (Scaling the first active
      // length instead picks a 47 s fragment and stays under the ratio for the
      // wrong reason, which is how an earlier version of this test passed with
      // the stroke check deleted.)
      const ms = 200_000;
      return patchFrame(f, { [F_ELAPSED]: ms, [F_TIMER]: ms, [F_STROKES]: getField(f, F_STROKES) });
    }
    return f.bytes;
  });
  const info = analyze(writeFit(header, out));
  assert.equal(info.findings.filter((f) => f.type === 'missed-turn').length, 0);
});
