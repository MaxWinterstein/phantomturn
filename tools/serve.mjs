#!/usr/bin/env node

// Minimal static file server for dist/. Exists so that previewing the site
// needs no dependency -- opening index.html over file:// would fail, because
// ES module imports are blocked by the same-origin policy there.

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

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

    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  }
}).listen(PORT, () => {
  console.log(`serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}`);
});
