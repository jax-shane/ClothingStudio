'use strict';
// Finds the archive decryption keys inside the user's own GTA5.exe.
//
// The exe stores the key material in plain form; we locate it by hashing 8-byte
// aligned windows and comparing against a table of known SHA-1 digests
// (key_hashes.json - digests only, no key material is shipped). The method and
// the digest table come from the open-source CodeWalker project (GPL-3.0).
// Results are cached on disk so the (about a minute long) scan runs once.

const fs = require('fs');
const crypto = require('crypto');
const HASHES = require('./key_hashes.json');

const AES_LEN = 32, NG_KEY_LEN = 0x110, TABLE_LEN = 0x400, LUT_LEN = 0x100;
const CACHE_MAGIC = 'CSKEYS01';

function scan(exe, hexList, len, label, onProgress) {
  const want = new Map();
  hexList.forEach((h, i) => { const a = want.get(h) || []; a.push(i); want.set(h, a); });
  const found = new Array(hexList.length).fill(null);
  let left = hexList.length;
  const end = exe.length - len;
  for (let p = 0; p <= end; p += 8) {
    const idx = want.get(crypto.hash('sha1', exe.subarray(p, p + len), 'hex'));
    if (idx) {
      const copy = Buffer.from(exe.subarray(p, p + len));
      for (const i of idx) if (!found[i]) { found[i] = copy; left--; }
      if (left === 0) break;
    }
    if (onProgress && (p & 0x3fffff) === 0) onProgress(label, p / exe.length);
  }
  return found;
}

// ---- recent builds: the NG tables are not in the exe any more. CodeWalker ships
// them in magic.dat, masked with a stream of pseudo-random bytes seeded from the
// game's own AES key (so they are only recoverable with a copy of the game).
const zlib = require('zlib');
const path = require('path');

class DotNetRandom { // System.Random(seed): the legacy subtractive generator
  constructor(seed) {
    const MBIG = 2147483647, MSEED = 161803398;
    const s = (this.s = new Int32Array(56));
    let mj = MSEED - (seed === -2147483648 ? 2147483647 : Math.abs(seed)), mk = 1;
    s[55] = mj;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      s[ii] = mk;
      mk = mj - mk; if (mk < 0) mk += MBIG;
      mj = s[ii];
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        s[i] -= s[1 + ((i + 30) % 55)];
        if (s[i] < 0) s[i] += MBIG;
      }
    }
    this.inext = 0; this.inextp = 21; this.MBIG = MBIG;
  }
  sample() {
    if (++this.inext >= 56) this.inext = 1;
    if (++this.inextp >= 56) this.inextp = 1;
    let r = this.s[this.inext] - this.s[this.inextp];
    if (r === this.MBIG) r--;
    if (r < 0) r += this.MBIG;
    this.s[this.inext] = r;
    return r;
  }
  bytes(n) { const b = Buffer.allocUnsafe(n); for (let i = 0; i < n; i++) b[i] = this.sample() & 0xff; return b; }
}

function jenkBytes(data) {
  let h = 0;
  for (let i = 0; i < data.length; i++) { h = (h + data[i]) >>> 0; h = (h + (h << 10)) >>> 0; h = (h ^ (h >>> 6)) >>> 0; }
  h = (h + (h << 3)) >>> 0; h = (h ^ (h >>> 11)) >>> 0; h = (h + (h << 15)) >>> 0;
  return h;
}

function keysFromMagic(aes, magic) {
  const rnd = new DotNetRandom(jenkBytes(aes) | 0);
  const n = magic.length;
  const rb = [rnd.bytes(n), rnd.bytes(n), rnd.bytes(n), rnd.bytes(n)];
  const db = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) db[i] = (magic[i] - rb[0][i] - rb[1][i] - rb[2][i] - rb[3][i]) & 0xff;
  const whole = n - (n % 16);
  const dec = crypto.createDecipheriv('aes-256-ecb', aes, null);
  dec.setAutoPadding(false);
  const plain = Buffer.concat([dec.update(db.subarray(0, whole)), dec.final(), db.subarray(whole)]);
  const data = zlib.inflateRawSync(plain);
  const NG = 101 * NG_KEY_LEN, TB = 272 * TABLE_LEN;
  if (data.length < NG + TB + LUT_LEN) throw new Error('unlocked data is too short');
  return {
    aes,
    ngKeys: Array.from({ length: 101 }, (_, i) => Buffer.from(data.subarray(i * NG_KEY_LEN, (i + 1) * NG_KEY_LEN))),
    tables: Array.from({ length: 272 }, (_, i) => Buffer.from(data.subarray(NG + i * TABLE_LEN, NG + (i + 1) * TABLE_LEN))),
    lut: Buffer.from(data.subarray(NG + TB, NG + TB + LUT_LEN)),
  };
}

function findKeys(exePath, onProgress) {
  const exe = fs.readFileSync(exePath);
  const aes = scan(exe, [HASHES.aes], AES_LEN, 'AES key', onProgress)[0];
  if (!aes) throw new Error('This GTA5.exe does not contain the expected AES key (unsupported build).');
  const magicFile = path.join(__dirname, 'magic.dat');
  if (fs.existsSync(magicFile)) {
    try { return keysFromMagic(aes, fs.readFileSync(magicFile)); } catch { /* fall through to a direct scan */ }
  }
  const ngKeys = scan(exe, HASHES.ngKeys, NG_KEY_LEN, 'NG keys', onProgress);
  const tables = scan(exe, HASHES.tables, TABLE_LEN, 'NG tables', onProgress);
  const lut = scan(exe, [HASHES.lut], LUT_LEN, 'hash table', onProgress)[0];
  if (!aes || !lut || ngKeys.some((k) => !k) || tables.some((t) => !t)) {
    const missing = [!aes && 'AES key', ngKeys.some((k) => !k) && 'NG keys', tables.some((t) => !t) && 'NG tables', !lut && 'hash table'].filter(Boolean);
    throw new Error('Could not locate the archive keys in this GTA5.exe (' + missing.join(', ') + ').');
  }
  return { aes, ngKeys, tables, lut };
}

function saveKeys(file, k) {
  fs.writeFileSync(file, Buffer.concat([Buffer.from(CACHE_MAGIC), k.aes, ...k.ngKeys, ...k.tables, k.lut]));
}

function loadKeys(file) {
  const b = fs.readFileSync(file);
  const total = 8 + AES_LEN + 101 * NG_KEY_LEN + 272 * TABLE_LEN + LUT_LEN;
  if (b.length !== total || b.toString('latin1', 0, 8) !== CACHE_MAGIC) throw new Error('key cache is invalid');
  let o = 8;
  const take = (n) => { const s = Buffer.from(b.subarray(o, o + n)); o += n; return s; };
  const aes = take(AES_LEN);
  const ngKeys = Array.from({ length: 101 }, () => take(NG_KEY_LEN));
  const tables = Array.from({ length: 272 }, () => take(TABLE_LEN));
  return { aes, ngKeys, tables, lut: take(LUT_LEN) };
}

function loadOrFindKeys(exePath, cacheFile, onProgress) {
  try { return loadKeys(cacheFile); } catch { /* not cached yet */ }
  const k = findKeys(exePath, onProgress);
  try { saveKeys(cacheFile, k); } catch { /* cache is optional */ }
  return k;
}

module.exports = { findKeys, loadOrFindKeys, loadKeys, saveKeys, scan, HASHES };
