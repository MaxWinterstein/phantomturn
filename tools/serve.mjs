#!/usr/bin/env node

// Minimal static file server for dist/. Exists so that previewing the site
// needs no dependency -- opening index.html over file:// would fail, because
// ES module imports are blocked by the same-origin policy there.

import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  console.error(`PORT must be a number between 1 and 65535, got "${process.env.PORT}"`);
  process.exit(2);
}

// Loopback only. Omitting the host binds 0.0.0.0, which puts dist/ on the
// whole network -- and `task web` gets run on café wifi.
const HOST = process.env.HOST ?? '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    // Strip the query string and refuse anything trying to climb out of ROOT.
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    let path = join(ROOT, rel);
    if (!path.startsWith(ROOT)) throw new Error('outside root');

    const info = await stat(path).catch(() => null);
    if (info?.isDirectory()) path = join(path, 'index.html');

    // Resolve symlinks before serving. The lexical check above is sound
    // against `../`, but says nothing about a link inside dist/ pointing out
    // of it -- and build-web copies web/ with fs.cp, which preserves symlinks.
    const real = await realpath(path);
    if (real !== ROOT && !real.startsWith(ROOT + sep)) throw new Error('outside root');

    const body = await readFile(real);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  }
}).listen(PORT, HOST, () => {
  console.log(`serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}`);
});
