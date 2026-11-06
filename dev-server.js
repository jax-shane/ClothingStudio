'use strict';
// Browser test harness (no Electron needed): serves renderer/ + three.js and
// exposes the same operations as main.js over HTTP so the UI can be driven in
// any browser. `npm run dev`, then open http://localhost:5173/renderer/index.html
// Writes are disabled unless started with --allow-write.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { scanPack } = require('./src/lib/pack');
const { readYdd } = require('./src/lib/ydd');
const ytd = require('./src/lib/ytd');

const PORT = 5173;
const ALLOW_WRITE = process.argv.includes('--allow-write');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const typed = (k, v) => {
  if (ArrayBuffer.isView(v)) {
    const t = v instanceof Float32Array ? 'f32' : v instanceof Uint16Array ? 'u16' : 'u8';
    return { __t: t, b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  }
  return v;
};

const { BodySource, detectGtaDir } = require('./src/lib/body');
const os = require('os');
let bodySource = null;

const routes = {
  bodystatus: () => ({ gtaDir: detectGtaDir() }),
  body: (b) => {
    const dir = detectGtaDir();
    if (!dir) throw new Error('GTA V folder not found');
    if (!bodySource) bodySource = new BodySource(dir, path.join(os.tmpdir(), 'cs-dev-keys.bin'));
    return bodySource.load(b.gender === 'female' ? 'female' : 'male', () => {});
  },
  scan: (b) => scanPack(b.path),
  mesh: (b) => readYdd(b.path),
  texture: (b) => ytd.decodeTexture(ytd.readYtd(b.path), 0),
  save: (b) => {
    if (!ALLOW_WRITE) throw new Error('dev server is read-only (start with --allow-write)');
    return ytd.patchTexture(b.path, 0, Buffer.from(b.rgba, 'base64'));
  },
};

http.createServer((req, res) => {
  // only this page on this machine may talk to it: a web page in another tab (or a DNS-rebinding host name) is refused
  const okHosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  const origin = req.headers.origin;
  if (!okHosts.includes(req.headers.host || '') || (origin && !okHosts.some((h) => origin === `http://${h}`))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const out = routes[url.pathname.slice(5)](body ? JSON.parse(body) : {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out, typed));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  const rel = decodeURIComponent(url.pathname);
  if (!/^\/(renderer|node_modules\/three)\//.test(rel)) { res.writeHead(404); res.end('not found'); return; }
  const file = path.join(__dirname, rel);
  if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`dev server: http://localhost:${PORT}/renderer/index.html  (writes ${ALLOW_WRITE ? 'ENABLED' : 'disabled'})`));
