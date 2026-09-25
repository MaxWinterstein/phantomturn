#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { analyze, DEFAULTS, repair } from './swim-repair.js';
import { fitEntries, isZip, readEntry } from './unzip.js';

const USAGE = `usage: fitfix <in.fit|in.zip> [out.fit] [options]

  The input may be the .zip Garmin Connect's "Export Original" hands you;
  the .fit inside is read straight out of it.

  --dry-run                report findings, write nothing
  --entry=NAME             which .fit to take, when the zip holds several
                           (a name, or its position in the listing)

Assumptions, calibrated on a Forerunner 265 and scaled to your pool:

  --pool-length=M          metres per length, when the watch was set wrong.
                           A mis-set pool makes every distance wrong by a
                           fixed ratio and nothing in the data reveals it.
                           Also rewritten into the output file.
  --lengths-per-lap=N|auto pool lengths one lap button press covers
                           (default ${DEFAULTS.lengthsPerLap}: worked out per lap from the
                           file, which is the only way to get a swim right
                           when you lapped every length at first and then
                           swam a continuous block)
  --stroke-split=N|auto    breaststroke at or above N strokes per length
                           (default ${DEFAULTS.strokeSplit}: scaled from the pool size, so
                           the same setting works in a 50 m and an 18 m pool)
  --duration-split=N|auto  seconds per length, cross-checks --stroke-split
                           (default ${DEFAULTS.durationSplit}, scaled the same way)
  --keep-stroke            leave the watch's stroke classification alone
  --keep-elapsed           leave total elapsed time as recorded

  --split-missed-turns[=LAPS]
                           split lengths that look like two the watch
                           recorded as one -- all of them, or only those in
                           the listed laps (e.g. =12,20). Off by default: it
                           invents where the turn fell, so use it for a turn
                           you actually remember.`;

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.error(USAGE);
  process.exit(args.length ? 0 : 2);
}
const flags = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => a.replace(/^--/, '').split('='))
    .map(([k, v]) => [k, v ?? true]),
);
const pos = args.filter((a) => !a.startsWith('--'));
const src = pos[0];

/** Numeric options, and whether each also accepts the string 'auto'. */
const NUMERIC = {
  'pool-length': { key: 'poolLength', auto: false },
  'lengths-per-lap': { key: 'lengthsPerLap', auto: true },
  'stroke-split': { key: 'strokeSplit', auto: true },
  'duration-split': { key: 'durationSplit', auto: true },
};
const BOOLEAN = { 'keep-stroke': 'reclassifyStroke', 'keep-elapsed': 'normalizeElapsed' };

/*
 * Reject anything unrecognised. Silently ignoring unknown flags meant
 * `--pool-length=18` was accepted and discarded, and the output looked
 * plausible while answering a different question -- the same defect that had
 * already been fixed in tools/scrub-fixtures.mjs and not here.
 */
const KNOWN = new Set([
  ...Object.keys(NUMERIC),
  ...Object.keys(BOOLEAN),
  'dry-run',
  'entry',
  'help',
  'split-missed-turns',
]);
const unknown = Object.keys(flags).filter((f) => !KNOWN.has(f));
if (unknown.length) {
  console.error(`unknown option(s): ${unknown.map((f) => `--${f}`).join(' ')}`);
  console.error(USAGE);
  process.exit(2);
}

const opts = { ...DEFAULTS };
for (const [flag, { key, auto }] of Object.entries(NUMERIC)) {
  if (flags[flag] === undefined) continue;
  if (auto && flags[flag] === 'auto') {
    opts[key] = 'auto';
    continue;
  }
  const n = Number(flags[flag]);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(
      `--${flag} needs a positive number${auto ? ' or "auto"' : ''}, got "${flags[flag]}"`,
    );
    process.exit(2);
  }
  opts[key] = n;
}
for (const [flag, key] of Object.entries(BOOLEAN)) if (flags[flag]) opts[key] = false;

/*
 * Laps are what a swimmer can name from the table, so that is what the flag
 * takes; the library wants finding keys, which are resolved once the file is
 * read. Validated here, like every other flag, rather than silently ignored.
 */
let splitLaps = null;
if (flags['split-missed-turns'] !== undefined) {
  const v = flags['split-missed-turns'];
  if (v === true) splitLaps = true;
  else if (/^\d+(,\d+)*$/.test(v)) splitLaps = new Set(v.split(',').map(Number));
  else {
    console.error(`--split-missed-turns takes lap numbers like =12,20, got "${v}"`);
    process.exit(2);
  }
}

const raw = new Uint8Array(await readFile(src));

/*
 * A zip is unwrapped here rather than in the library: `repair()` takes bytes
 * and stays synchronous, and inflating cannot be. Which .fit to take is a
 * question the caller has to answer anyway, and the answer differs between a
 * terminal and a browser.
 *
 * Naming follows the file that came out, not the archive it came in: the
 * archive may hold several, and `activity_123_fixed.fit` would then name three
 * different swims. Only the basename is used, so a nested entry cannot steer
 * the write anywhere but next to the input.
 */
let u8 = raw;
let label = basename(src);

if (isZip(raw)) {
  const entries = fitEntries(raw);
  if (!entries.length) {
    console.error(`${basename(src)}: no .fit file inside this archive`);
    process.exit(2);
  }

  let chosen = entries[0];
  if (entries.length > 1) {
    const want = flags.entry;
    if (want === undefined || want === true) {
      console.error(
        `${basename(src)} holds ${entries.length} .fit files -- pick one with --entry:`,
      );
      for (const [i, e] of entries.entries()) console.error(`  ${i + 1}. ${e.name}`);
      process.exit(2);
    }
    /*
     * By position as listed above, or by name. An exact path always wins; a
     * bare basename is accepted too, because the full path inside a bulk export
     * is a mouthful -- but only when it picks out exactly one file.
     *
     * `2025/swim.fit` and `2026/swim.fit` are different swims, and taking the
     * first is the one thing this tool must not do. The browser refuses to
     * choose between activity files for the same reason.
     */
    if (/^\d+$/.test(want)) {
      chosen = entries[Number(want) - 1];
    } else {
      chosen = entries.find((e) => e.name === want);
      if (!chosen) {
        const byBase = entries.filter((e) => basename(e.name) === want);
        if (byBase.length > 1) {
          console.error(`${basename(src)}: "${want}" matches ${byBase.length} files -- name one:`);
          for (const e of byBase) console.error(`  ${e.name}`);
          process.exit(2);
        }
        chosen = byBase[0];
      }
    }
    if (!chosen) {
      console.error(`${basename(src)}: no entry matching "${want}"`);
      process.exit(2);
    }
  }

  u8 = await readEntry(raw, chosen);
  label = basename(chosen.name);
  console.log(`${basename(src)}: read ${chosen.name} (${u8.length} bytes)`);
}

const dst = pos[1] ?? join(dirname(src), `${label.replace(/\.fit$/i, '')}_fixed.fit`);

if (splitLaps === true) {
  opts.splitMissedTurns = true;
  // Said, not silently skipped: "I asked for a split and nothing happened"
  // should never have to be worked out from the distance alone.
  if (
    !analyze(u8, { ...opts, splitMissedTurns: false }).findings.some(
      (f) => f.type === 'missed-turn',
    )
  )
    console.warn(`${label}: --split-missed-turns: no possible missed turn to split`);
} else if (splitLaps) {
  const found = analyze(u8, { ...opts, splitMissedTurns: false }).findings.filter(
    (f) => f.type === 'missed-turn',
  );
  const unknown = [...splitLaps].filter((n) => !found.some((f) => f.lap + 1 === n));
  if (unknown.length) {
    console.error(`--split-missed-turns: no possible missed turn in lap ${unknown.join(', ')}`);
    process.exit(2);
  }
  opts.splitMissedTurns = found.filter((f) => splitLaps.has(f.lap + 1)).map((f) => f.key);
}

if (flags['dry-run']) {
  const info = analyze(u8, opts);
  console.log(
    `${label}: ${info.laps} laps, ${info.lengths} lengths, ` +
      `pool ${info.poolM} m, timer ${(info.timerMs / 60000).toFixed(1)} min`,
  );
  for (const f of info.findings) console.log('  -', f.type, JSON.stringify(f));
  printWorking(info);
  process.exit(0);
}

/**
 * The per-lap breakdown: what the watch recorded, what the repair will leave,
 * and each recorded length on its own.
 *
 * The findings say *that* a lap was merged; this says why it was believable.
 * "47 + 44" against a one-length reference of ~81 s is visibly one length the
 * watch split in two, and "81 + 84 + 95" is visibly three real ones -- the
 * totals alone cannot tell those apart, and that is the question someone is
 * asking when a repaired distance looks wrong. Mirrors "Show the working" in
 * the browser.
 */
function printWorking(info) {
  if (!info.swimLaps.length) return;
  console.log('');
  console.log(
    info.lengthUnitS
      ? `  working -- one length reads as ~${Math.round(info.lengthUnitS)} s`
      : info.autoLengths
        ? '  working -- auto, but no usable durations: each lap taken as one length'
        : '  working -- lengths per lap was fixed, not inferred',
  );
  // Lap numbers skip wherever the swimmer rested: a rest lap holds no lengths,
  // so it has nothing to show. Said here so the gaps do not read as a bug.
  console.log('    lap  watch    fixed  the lengths it saw (s)       rest laps not shown');
  for (const l of info.swimLaps) {
    const merged = l.lengths > l.target;
    const seen = l.lengthsS
      .map((s, i) =>
        s === null ? '?' : `${Math.round(s)}${l.missedTurns[i] ? '!' : ''}${l.split[i] ? '*' : ''}`,
      )
      .join(' + ');
    const missed = l.missedTurns.some(Boolean);
    console.log(
      `    ${String(l.lap + 1).padStart(3)}  ${String(l.recorded).padStart(5)} -> ${String(l.target).padEnd(5)}  ${seen}${merged ? '   merged' : ''}${missed ? '   possible missed turn' : ''}${l.split.some(Boolean) ? '   split (* made up)' : ''}`,
    );
  }
}

const { bytes, summary, info } = repair(u8, opts);

if (opts.lengthsPerLap === 'auto' && info.lengthUnitS) {
  const varied = new Set(info.lapTargets).size > 1;
  console.log(
    `  one length reads as ~${info.lengthUnitS.toFixed(0)}s; ` +
      (varied
        ? `lengths per lap varied: ${info.lapTargets.filter((_, i) => info.lapLengths[i].length).join(', ')}`
        : 'one length per lap throughout'),
  );
}

/*
 * Also loud, for the opposite reason: the file comes out short. The tool only
 * splits when asked -- a split invents a turn the watch never recorded -- so
 * by default the most it does is say so, and how to ask.
 */
for (const f of info.findings.filter((f) => f.type === 'missed-turn')) {
  console.warn('');
  if (f.split && f.gained === 0) {
    console.warn(
      `  !!  lap ${f.lap + 1}: split as asked, but the fixed --lengths-per-lap merges the parts`,
    );
    console.warn(
      '  !!  straight back -- the distance is unchanged by it. Use auto for it to count.',
    );
    continue;
  }
  if (f.split) {
    console.warn(
      `  !!  lap ${f.lap + 1}: split a ${Math.round(f.durS)} s length into ${f.looksLike}, as asked.`,
    );
    console.warn('  !!  The turn is put halfway -- those lengths are made up, not recorded.');
    continue;
  }
  console.warn(
    `  !!  lap ${f.lap + 1}: possible missed turn -- one length took ${Math.round(f.durS)} s`,
  );
  console.warn(
    `  !!  with ${f.strokes} strokes, about ${f.looksLike} lengths' worth (one is ~${Math.round(f.unitS)} s).`,
  );
  console.warn(
    `  !!  The distance is probably ${f.looksLike - 1} length(s) short. --split-missed-turns=${f.lap + 1} splits it.`,
  );
}

// Loud, before anything else: this is the case where the output is garbage.
const structure = info.findings.find((f) => f.type === 'lap-structure');
if (structure) {
  console.warn('');
  console.warn('  !!  CHECK THIS FILE BEFORE USING IT');
  console.warn(`  !!  ${structure.note}`);
  console.warn(`  !!  ${structure.lengthsBefore} lengths would become ${structure.lengthsAfter}.`);
  console.warn('');
}

await writeFile(dst, bytes);
const phantom = info.findings.filter((f) => f.type === 'phantom-turn').length;
const restroke = info.findings.filter((f) => f.type === 'stroke-mismatch').length;
console.log(
  `${basename(dst)}: ${summary.distanceM} m, ${summary.lengths} lengths, ` +
    `${summary.strokes} strokes, swim time ${(summary.swimS / 60).toFixed(1)} min`,
);
console.log(`  phantom turns: ${phantom}, stroke reclassified: ${restroke}`);
for (const f of info.findings.filter((f) => f.type === 'ambiguous-stroke'))
  console.log(
    `  ! lap ${f.lap}: stroke count (${f.strokes}) and duration ` +
      `(${f.durS.toFixed(0)}s) disagree`,
  );
