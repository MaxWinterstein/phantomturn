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

test('a file it cannot safely repair fails loudly', async () => {
  const truncated = join(dir, 'truncated.fit');
  await writeFile(truncated, (await readFixture('swim-02.fit')).subarray(0, 4000));

  const { code, stderr } = await cli([truncated]);
  assert.notEqual(code, 0, 'should not exit 0 on a broken file');
  assert.match(stderr, /data_size|malformed|past the data section/);
});
