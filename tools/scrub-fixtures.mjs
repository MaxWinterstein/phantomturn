#!/usr/bin/env node

// Scrub personal data out of FIT files before they are committed as test
// fixtures. A thin CLI over packages/fitfix/src/anonymize.js, plus a check for
// values known to appear in *this* project's source files.
//
// WHY GOLDEN FILES ARE SCRUBBED RATHER THAN REGENERATED
// The same transform is applied to the originals and to the golden files the
// Python reference produced. That is sound because repair() never writes a
// timestamp or an identity field, so the two commute:
//
//     anonymize(repair(x)) == repair(anonymize(x))
//
// The goldens therefore still encode Python's arithmetic, and golden.test.mjs
// stays a real cross-implementation check. Regenerating them with this
// codebase would reduce it to "JS agrees with JS", which proves nothing.
// anonymize.test.mjs asserts the commutation so it cannot silently break.
//
// Usage:  node tools/scrub-fixtures.mjs <file.fit> [...]   (rewrites in place)
//         node tools/scrub-fixtures.mjs --check <file.fit> [...]

import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { anonymize, audit } from '../packages/fitfix/src/anonymize.js';

/**
 * Strings known to have appeared in your own exports -- a name, a watch serial,
 * a sensor id. `audit()` checks structure; this is an independent cross-check
 * that catches a literal value surviving somewhere the structure check does not
 * think to look.
 *
 * Deliberately NOT committed. These were hardcoded here at first, which made
 * the privacy guard publish the serial number it was guarding -- fine while
 * the repository is private, not fine afterwards. Put your own values in
 * `tools/needles.local.json` (gitignored) as a JSON array of strings.
 */
async function loadNeedles() {
  try {
    const raw = await readFile(new URL('./needles.local.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'string' && n) : [];
  } catch {
    return []; // absent is the normal case for anyone but the file's owner
  }
}

const NEEDLES = await loadNeedles();

function check(u8) {
  const problems = audit(u8);
  const text = new TextDecoder('latin1').decode(u8);
  for (const needle of NEEDLES) {
    if (text.includes(needle)) problems.push(`plain-text "${needle}"`);
  }
  return [...new Set(problems)];
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const files = args.filter((a) => !a.startsWith('--'));

/*
 * Fail on anything unrecognised rather than ignoring it. Two ways the old
 * permissive parse went wrong in a script that is meant to be a last line of
 * defence: a path beginning with `--` was silently dropped from the file list
 * and never checked, and a typo like `--checks` fell through to the *default*
 * mode, which rewrites every named file in place.
 */
const unknown = args.filter((a) => a.startsWith('--') && a !== '--check');
if (unknown.length) {
  console.error(`unknown option(s): ${unknown.join(' ')}`);
  console.error('usage: scrub-fixtures.mjs [--check] <file.fit> [...]');
  process.exit(2);
}

if (!files.length) {
  console.error('usage: scrub-fixtures.mjs [--check] <file.fit> [...]');
  process.exit(2);
}

let bad = 0;
for (const path of files) {
  const u8 = new Uint8Array(await readFile(path));
  const subject = checkOnly ? u8 : anonymize(u8).bytes;

  if (!checkOnly) await writeFile(path, subject);

  const problems = check(subject);
  if (problems.length) {
    bad++;
    console.log(`FAIL ${basename(path)}: ${problems.join('; ')}`);
  } else if (checkOnly) {
    console.log(`ok   ${basename(path)}`);
  } else {
    console.log(`scrubbed ${basename(path)}  ${u8.length} -> ${subject.length} B`);
  }
}
process.exit(bad ? 1 : 0);
