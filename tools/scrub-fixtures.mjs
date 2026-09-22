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
//         node tools/scrub-fixtures.mjs --source <file> [...]   (text scan only)

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
  const strings = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === 'string' && n) : []);
  try {
    const raw = await readFile(new URL('./needles.local.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    // A bare array is the original format and still means "check these in FIT
    // files". The source scan gets nothing from it on purpose: those lists were
    // written for binary payloads and contain the owner's name, which is
    // *deliberately* in LICENSE, package.json and web/legal.html. Scanning
    // source for it reports four files every run, and a check that is always
    // red is one nobody reads.
    if (Array.isArray(parsed)) return { fit: strings(parsed), source: [] };
    return { fit: strings(parsed.fit), source: strings(parsed.source) };
  } catch {
    return { fit: [], source: [] }; // absent is normal for anyone but the owner
  }
}

const { fit: NEEDLES, source: SOURCE_NEEDLES } = await loadNeedles();

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
const sourceOnly = args.includes('--source');
const files = args.filter((a) => !a.startsWith('--'));

/*
 * Fail on anything unrecognised rather than ignoring it. Two ways the old
 * permissive parse went wrong in a script that is meant to be a last line of
 * defence: a path beginning with `--` was silently dropped from the file list
 * and never checked, and a typo like `--checks` fell through to the *default*
 * mode, which rewrites every named file in place.
 */
const unknown = args.filter((a) => a.startsWith('--') && a !== '--check' && a !== '--source');
if (unknown.length) {
  console.error(`unknown option(s): ${unknown.join(' ')}`);
  console.error('usage: scrub-fixtures.mjs [--check | --source] <file> [...]');
  process.exit(2);
}

if (!files.length) {
  console.error('usage: scrub-fixtures.mjs [--check | --source] <file> [...]');
  process.exit(2);
}

/*
 * --source: the needle scan, pointed at everything else in the repository.
 *
 * The .fit guardrails all select on the extension, so nothing ever looked at
 * the source. That gap is not hypothetical -- a real Garmin activity id
 * reached three tracked files as a "realistic" test filename, and every check
 * in the project passed. A Garmin export is `<activityId>_ACTIVITY.fit` and
 * that id resolves to a real activity, so the *name* is personal data even
 * where no file is; see AGENTS.md.
 *
 * It reads the `source` list, not the `fit` one -- see loadNeedles(). Binary
 * files are decoded as latin1 rather than skipped: a needle is a byte
 * sequence, and guessing which paths are "text" is how a check acquires a
 * blind spot. Quiet unless something matches -- this runs over every tracked
 * file and a per-file "ok" would bury the one line that matters.
 */
if (sourceOnly) {
  const hits = new Set();
  for (const path of files) {
    const text = new TextDecoder('latin1').decode(await readFile(path));
    for (const needle of SOURCE_NEEDLES) {
      const at = text.indexOf(needle);
      if (at < 0) continue;
      hits.add(`${path}:${text.slice(0, at).split('\n').length}`);
    }
  }
  // Never print the needle itself. The first version of this list committed the
  // serial number it existed to protect; a failure message is just as public.
  for (const hit of hits) console.log(`FAIL ${hit}: contains a string from the "source" needles`);
  if (hits.size) {
    console.log(`\n${hits.size} file(s). The values are in tools/needles.local.json.`);
  } else if (SOURCE_NEEDLES.length) {
    console.log(`ok   ${files.length} files, no known personal strings`);
  } else {
    console.log('ok   (no "source" needles configured, so nothing to look for)');
  }
  process.exit(hits.size ? 1 : 0);
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
