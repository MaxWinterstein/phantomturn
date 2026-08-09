#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { analyze, DEFAULTS, repair } from './swim-repair.js';

const USAGE = `usage: fitfix <in.fit> [out.fit] [options]

  --dry-run                report findings, write nothing

Assumptions, all calibrated on a Forerunner 265 in a 50 m pool:

  --lengths-per-lap=N|auto pool lengths one lap button press covers
                           (default ${DEFAULTS.lengthsPerLap}: worked out per lap from the
                           file, which is the only way to get a swim right
                           when you lapped every length at first and then
                           swam a continuous block)
  --stroke-split=N         breaststroke at or above N strokes per length
                           (default ${DEFAULTS.strokeSplit}; roughly halve it for a 25 m pool)
  --duration-split=N       seconds per length, cross-checks --stroke-split
                           (default ${DEFAULTS.durationSplit})
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

const opts = { ...DEFAULTS };
const numeric = {
  'lengths-per-lap': 'lengthsPerLap',
  'stroke-split': 'strokeSplit',
  'duration-split': 'durationSplit',
};
for (const [flag, key] of Object.entries(numeric)) {
  if (flags[flag] === undefined) continue;
  if (key === 'lengthsPerLap' && flags[flag] === 'auto') {
    opts[key] = 'auto';
    continue;
  }
  const n = Number(flags[flag]);
  if (!Number.isFinite(n) || n <= 0) {
    const allowed = key === 'lengthsPerLap' ? 'a positive number or "auto"' : 'a positive number';
    console.error(`--${flag} needs ${allowed}, got "${flags[flag]}"`);
    process.exit(2);
  }
  opts[key] = n;
}
if (flags['keep-stroke']) opts.reclassifyStroke = false;
if (flags['keep-elapsed']) opts.normalizeElapsed = false;

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
