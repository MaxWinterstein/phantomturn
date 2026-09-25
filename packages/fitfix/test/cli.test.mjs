/**
 * The command line entry point.
 *
 * It is the one file exposed as `bin`, and nothing executed it -- so a syntax
 * error or a broken flag would have shipped with a green suite behind it.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readFixture } from './fixtures.mjs';
import { makeZip } from './zip-writer.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

let dir;
let input;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fitfix-cli-'));
  input = join(dir, 'swim.fit');
  await writeFile(input, await readFixture('swim-02.fit'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** execFile rejects on a non-zero exit; normalise both into one shape. */
const cli = (args) =>
  run(process.execPath, [CLI, ...args]).catch((err) => ({
    stdout: err.stdout ?? '',
    stderr: err.stderr ?? '',
    code: err.code,
  }));

test('--help lists every assumption and exits cleanly', async () => {
  const { stderr, code } = await cli(['--help']);
  assert.equal(code, undefined, 'help should exit 0');
  for (const flag of [
    '--lengths-per-lap',
    '--stroke-split',
    '--duration-split',
    '--keep-stroke',
    '--keep-elapsed',
    '--dry-run',
  ]) {
    assert.ok(stderr.includes(flag), `${flag} missing from --help`);
  }
});

test('--dry-run reports without writing anything', async () => {
  const out = join(dir, 'should-not-exist.fit');
  const { stdout } = await cli([input, out, '--dry-run']);

  assert.match(stdout, /35 laps, 40 lengths, pool 50 m/);
  assert.match(stdout, /phantom-turn/);
  await assert.rejects(readFile(out), /ENOENT/, '--dry-run wrote a file');
});

test('--dry-run shows the working, lap by lap', async () => {
  // swim-07 has exactly one phantom split among real multi-length blocks, so
  // the breakdown has to show both the merge and the blocks it left alone.
  const swim07 = join(dir, 'swim-07.fit');
  await writeFile(swim07, await readFixture('swim-07.fit'));
  const { stdout } = await cli([swim07, '--dry-run']);

  assert.match(stdout, /working -- one length reads as ~81 s/);
  assert.match(stdout, /^\s+2\s+2 -> 1\s+47 \+ 44\s+merged$/m, 'the phantom split, merged');
  assert.match(stdout, /^\s+18\s+3 -> 3\s+81 \+ 84 \+ 95$/m, 'a real block, kept');
});

test('repairs a file and honours the assumptions', async () => {
  const fixed = join(dir, 'fixed.fit');
  const { stdout } = await cli([input, fixed]);
  assert.match(stdout, /900 m, 18 lengths/);
  assert.ok((await readFile(fixed)).length > 0);

  // A target high enough that nothing merges leaves the watch's own count.
  const kept = join(dir, 'kept.fit');
  const raised = await cli([input, kept, '--lengths-per-lap=8']);
  assert.match(raised.stdout, /1100 m, 22 lengths/);
});

test('a bad flag value is refused rather than guessed at', async () => {
  const { stderr, code } = await cli([input, '--stroke-split=abc']);
  assert.equal(code, 2);
  assert.match(stderr, /needs a positive number/);
});

/*
 * The zip path, end to end through the real binary.
 *
 * Testing the reader directly is not enough: `--entry` picking the wrong file
 * and the default output name being derived from the archive rather than the
 * file inside are both mistakes that leave every unit test green while the
 * swimmer gets back someone else's swim under a plausible name.
 *
 * The two entries are different fixtures on purpose -- swim-02 repairs to
 * 900 m, swim-03 to 1000 m -- so the numbers alone say which one was opened.
 */
const twoSwims = async () => [
  ['2025/holiday.fit', await readFixture('swim-02.fit')],
  ['2026/tuesday.fit', await readFixture('swim-03.fit')],
];

test('a single-activity zip is repaired, named after the file inside', async () => {
  const zip = join(dir, 'activity_12345.zip');
  await writeFile(zip, await makeZip([['12345_ACTIVITY.fit', await readFixture('swim-02.fit')]]));

  const { stdout } = await cli([zip]);
  assert.match(stdout, /read 12345_ACTIVITY\.fit/);
  assert.match(stdout, /900 m, 18 lengths/);

  // Next to the archive, named after its contents -- not activity_..._fixed.fit.
  const written = join(dir, '12345_ACTIVITY_fixed.fit');
  assert.ok((await readFile(written)).length > 0, 'expected 12345_ACTIVITY_fixed.fit');
});

test('--entry picks by position and by name, and names the output after it', async () => {
  const zip = join(dir, 'export.zip');
  await writeFile(zip, await makeZip(await twoSwims()));

  const byIndex = await cli([zip, '--entry=2']);
  assert.match(byIndex.stdout, /read 2026\/tuesday\.fit/);
  assert.match(byIndex.stdout, /1000 m, 20 lengths/, 'position 2 is swim-03');
  assert.ok((await readFile(join(dir, 'tuesday_fixed.fit'))).length > 0);

  const byPath = await cli([zip, '--entry=2025/holiday.fit']);
  assert.match(byPath.stdout, /900 m, 18 lengths/, 'the exact path is swim-02');
  assert.ok((await readFile(join(dir, 'holiday_fixed.fit'))).length > 0);

  const byBase = await cli([zip, '--entry=tuesday.fit']);
  assert.match(byBase.stdout, /1000 m, 20 lengths/, 'a unique basename is enough');
});

test('several activities and no --entry lists them instead of guessing', async () => {
  const zip = join(dir, 'export.zip');
  await writeFile(zip, await makeZip(await twoSwims()));

  const { stderr, code } = await cli([zip]);
  assert.equal(code, 2);
  assert.match(stderr, /holds 2 \.fit files/);
  assert.match(stderr, /1\. 2025\/holiday\.fit/);
  assert.match(stderr, /2\. 2026\/tuesday\.fit/);
});

test('an ambiguous basename is refused rather than resolved to the first', async () => {
  // Two years of the same filename is the ordinary shape of a bulk export, and
  // picking whichever came first would repair the wrong swim silently.
  const zip = join(dir, 'ambiguous.zip');
  await writeFile(
    zip,
    await makeZip([
      ['2025/swim.fit', await readFixture('swim-02.fit')],
      ['2026/swim.fit', await readFixture('swim-03.fit')],
    ]),
  );

  const { stderr, code } = await cli([zip, '--entry=swim.fit']);
  assert.equal(code, 2, 'must not pick one');
  assert.match(stderr, /matches 2 files/);
  assert.match(stderr, /2025\/swim\.fit/);
  assert.match(stderr, /2026\/swim\.fit/);

  // The full path still resolves it.
  const exact = await cli([zip, '--entry=2026/swim.fit']);
  assert.match(exact.stdout, /1000 m, 20 lengths/);
});

test('a zip with no activity file in it says so', async () => {
  const zip = join(dir, 'nothing.zip');
  await writeFile(zip, await makeZip([['readme.txt', new TextEncoder().encode('hello')]]));

  const { stderr, code } = await cli([zip]);
  assert.equal(code, 2);
  assert.match(stderr, /no \.fit file inside/);
});

test('--split-missed-turns splits only when asked, and only a real one', async () => {
  const swim08 = join(dir, 'swim-08.fit');
  await writeFile(swim08, await readFixture('swim-08.fit'));

  const plain = await cli([swim08, join(dir, 'plain.fit')]);
  assert.match(plain.stdout, /1050 m, 21 lengths/, 'off by default');
  assert.match(plain.stderr, /--split-missed-turns=12 splits it/, 'and it says how');

  const split = await cli([swim08, join(dir, 'split.fit'), '--split-missed-turns=12']);
  assert.match(split.stdout, /1100 m, 22 lengths/);
  assert.match(split.stderr, /made up, not recorded/);

  const wrong = await cli([swim08, '--split-missed-turns=3']);
  assert.equal(wrong.code, 2, 'a lap with no missed turn is refused, not ignored');
  assert.match(wrong.stderr, /no possible missed turn in lap 3/);
});

test('a file it cannot safely repair fails loudly', async () => {
  const truncated = join(dir, 'truncated.fit');
  await writeFile(truncated, (await readFixture('swim-02.fit')).subarray(0, 4000));

  const { code, stderr } = await cli([truncated]);
  assert.notEqual(code, 0, 'should not exit 0 on a broken file');
  assert.match(stderr, /data_size|malformed|past the data section/);
});
