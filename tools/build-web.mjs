#!/usr/bin/env node
/**
 * Assembles the static site into dist/.
 *
 * There is no bundler and there never needs to be one: the library is
 * dependency-free ES modules, so the browser can import it directly. This
 * script only arranges the files so that `./lib/swim-repair.js` resolves both
 * locally and on GitHub Pages.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);

/** Browser-facing library files. cli.mjs is Node-only and stays out. */
const LIB = ['fit-patch.js', 'swim-repair.js', 'anonymize.js', 'unzip.js'];

/**
 * Sample file offered on the page. This is a scrubbed test fixture -- it has
 * no serial number, no user profile and no real dates. Only ever point this at
 * something that passes `task fixtures:check`.
 */
const SAMPLE = 'packages/fitfix/test/fixtures/swim-03.fit';

await rm(dist, { recursive: true, force: true });
await mkdir(new URL('lib/', dist), { recursive: true });
await mkdir(new URL('sample/', dist), { recursive: true });

await cp(new URL('web/', root), dist, { recursive: true });
for (const f of LIB) {
  await cp(new URL(`packages/fitfix/src/${f}`, root), new URL(`lib/${f}`, dist));
}
await cp(new URL(SAMPLE, root), new URL('sample/pool-swim.fit', dist));

// Without this, GitHub Pages runs the output through Jekyll, which drops files
// and directories whose names begin with an underscore.
await writeFile(new URL('.nojekyll', dist), '');

/*
 * Prove the module graph actually resolves.
 *
 * LIB is hand-maintained, so adding a module under packages/fitfix/src/ and
 * forgetting it here leaves unit tests, lint and this copy step all green
 * while the deployed page 404s an import -- which kills every script on it.
 * The page then renders perfectly and does nothing at all.
 */
const files = await readdir(dist, { recursive: true });
const scripts = files.filter((f) => f.endsWith('.js'));
const missing = [];

for (const script of scripts) {
  const source = await readFile(new URL(script, dist), 'utf8');
  for (const [, spec] of source.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
    const target = fileURLToPath(new URL(spec, new URL(script, dist)));
    if (!existsSync(target)) missing.push(`${script} -> ${spec}`);
  }
}

if (missing.length) {
  console.error('unresolved imports in the built site:');
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}

console.log(`built ${fileURLToPath(dist)}`);
for (const f of files.sort()) console.log(`  ${f}`);
console.log(`  (${scripts.length} scripts, all imports resolve)`);
