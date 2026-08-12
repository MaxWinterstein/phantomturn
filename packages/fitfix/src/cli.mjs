#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { analyze, DEFAULTS, repair } from './swim-repair.js';

const USAGE = `usage: fitfix <in.fit> [out.fit] [options]

  --dry-run                report findings, write nothing

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
  --keep-elapsed           leave total elapsed time as recorded`;

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
const dst = pos[1] ?? `${src.replace(/\.fit$/i, '')}_fixed.fit`;

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
const KNOWN = new Set([...Object.keys(NUMERIC), ...Object.keys(BOOLEAN), 'dry-run', 'help']);
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

const u8 = new Uint8Array(await readFile(src));

if (flags['dry-run']) {
  const info = analyze(u8, opts);
  console.log(
    `${basename(src)}: ${info.laps} laps, ${info.lengths} lengths, ` +
      `pool ${info.poolM} m, timer ${(info.timerMs / 60000).toFixed(1)} min`,
  );
  for (const f of info.findings) console.log('  -', f.type, JSON.stringify(f));
  process.exit(0);
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
