'use strict';
// Minimal reader for GTA V "RPF7" archives (read only): enough to list the
// contents of an archive (including archives nested inside archives) and to
// extract individual files. Format knowledge from the open-source CodeWalker.

const fs = require('fs');
const zlib = require('zlib');

const RPF7 = 0x52504637;
const ENC = { NONE: 0, OPEN: 0x4e45504f, AES: 0x0ffffff9, NG: 0x0fefffff };

// ------------------------------------------------------------------ crypto
class Crypto {
  constructor(keys) {
    this.keys = keys;
    // keys as uint32 words, tables as one flat Uint32Array [round][table][256]
    this.ngKeys = keys.ngKeys.map((k) => new Uint32Array(k.buffer.slice(k.byteOffset, k.byteOffset + k.length)));
    this.T = new Uint32Array(17 * 16 * 256);
    keys.tables.forEach((t, i) => this.T.set(new Uint32Array(t.buffer.slice(t.byteOffset, t.byteOffset + t.length)), i * 256));
    this.lut = keys.lut;
    this.aes = keys.aes;
  }

  hash(name) { // the archive's filename hash (picks which NG key to use)
    let r = 0;
    for (let i = 0; i < name.length; i++) {
      r = Math.imul(1025, (this.lut[name.charCodeAt(i) & 0xff] + r) >>> 0) >>> 0;
      r = ((r >>> 6) ^ r) >>> 0;
    }
    const t = Math.imul(9, r) >>> 0;
    return Math.imul(32769, ((t >>> 11) ^ t) >>> 0) >>> 0;
  }

  ngKey(name, length) {
    return this.ngKeys[((this.hash(name) + (length >>> 0) + 61) >>> 0) % 101];
  }

  decryptNG(data, name, length) {
    const key = this.ngKey(name, length), T = this.T;
    const out = Buffer.from(data); // copy; trailing bytes (< 16) stay as they are
    const s = new Uint8Array(16);
    const blocks = Math.floor(data.length / 16);
    for (let b = 0; b < blocks; b++) {
      const o = b * 16;
      for (let i = 0; i < 16; i++) s[i] = data[o + i];
      for (let r = 0; r < 17; r++) {
        const t = r * 4096, k = r * 4;
        let x1, x2, x3, x4;
        if (r === 0 || r === 1 || r === 16) {
          x1 = T[t + s[0]] ^ T[t + 256 + s[1]] ^ T[t + 512 + s[2]] ^ T[t + 768 + s[3]] ^ key[k];
          x2 = T[t + 1024 + s[4]] ^ T[t + 1280 + s[5]] ^ T[t + 1536 + s[6]] ^ T[t + 1792 + s[7]] ^ key[k + 1];
          x3 = T[t + 2048 + s[8]] ^ T[t + 2304 + s[9]] ^ T[t + 2560 + s[10]] ^ T[t + 2816 + s[11]] ^ key[k + 2];
          x4 = T[t + 3072 + s[12]] ^ T[t + 3328 + s[13]] ^ T[t + 3584 + s[14]] ^ T[t + 3840 + s[15]] ^ key[k + 3];
        } else {
          x1 = T[t + s[0]] ^ T[t + 1792 + s[7]] ^ T[t + 2560 + s[10]] ^ T[t + 3328 + s[13]] ^ key[k];
          x2 = T[t + 256 + s[1]] ^ T[t + 1024 + s[4]] ^ T[t + 2816 + s[11]] ^ T[t + 3584 + s[14]] ^ key[k + 1];
          x3 = T[t + 512 + s[2]] ^ T[t + 1280 + s[5]] ^ T[t + 2048 + s[8]] ^ T[t + 3840 + s[15]] ^ key[k + 2];
          x4 = T[t + 768 + s[3]] ^ T[t + 1536 + s[6]] ^ T[t + 2304 + s[9]] ^ T[t + 3072 + s[12]] ^ key[k + 3];
        }
        s[0] = x1; s[1] = x1 >>> 8; s[2] = x1 >>> 16; s[3] = x1 >>> 24;
        s[4] = x2; s[5] = x2 >>> 8; s[6] = x2 >>> 16; s[7] = x2 >>> 24;
        s[8] = x3; s[9] = x3 >>> 8; s[10] = x3 >>> 16; s[11] = x3 >>> 24;
        s[12] = x4; s[13] = x4 >>> 8; s[14] = x4 >>> 16; s[15] = x4 >>> 24;
      }
      for (let i = 0; i < 16; i++) out[o + i] = s[i];
    }
    return out;
  }

  decryptAES(data) {
    const n = data.length - (data.length % 16);
    const d = require('crypto').createDecipheriv('aes-256-ecb', this.aes, null);
    d.setAutoPadding(false);
    const body = Buffer.concat([d.update(data.subarray(0, n)), d.final()]);
    return Buffer.concat([body, data.subarray(n)]);
  }
}

// ------------------------------------------------------------------ sources
class FileSource {
  constructor(path) { this.fd = fs.openSync(path, 'r'); this.size = fs.fstatSync(this.fd).size; }
  read(off, len) {
    const b = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(this.fd, b, got, len - got, off + got);
      if (n <= 0) break;
      got += n;
    }
    return got === len ? b : b.subarray(0, got);
  }
  close() { fs.closeSync(this.fd); }
}

// ------------------------------------------------------------------ archive
class Rpf {
  /** @param base byte offset of this archive inside `src`  @param size logical size (used for the NG key) */
  constructor(crypto, src, base, name, size, parentPath) {
    this.crypto = crypto; this.src = src; this.base = base; this.name = name; this.size = size;
    this.path = parentPath ? parentPath + '/' + name.toLowerCase() : name.toLowerCase();
    this.entries = [];
    this.readHeader();
  }

  readHeader() {
    const h = this.src.read(this.base, 16);
    if (h.length < 16 || h.readUInt32LE(0) !== RPF7) throw new Error('not an RPF7 archive: ' + this.name);
    const count = h.readUInt32LE(4), namesLen = h.readUInt32LE(8), enc = h.readUInt32LE(12);
    let ent = this.src.read(this.base + 16, count * 16);
    let nam = this.src.read(this.base + 16 + count * 16, namesLen);
    this.encryption = enc;
    if (enc === ENC.AES) { ent = this.crypto.decryptAES(ent); nam = this.crypto.decryptAES(nam); }
    else if (enc !== ENC.NONE && enc !== ENC.OPEN) {
      ent = this.crypto.decryptNG(ent, this.name, this.size);
      nam = this.crypto.decryptNG(nam, this.name, this.size);
    }
    this.isNG = enc !== ENC.NONE && enc !== ENC.OPEN && enc !== ENC.AES;
    this.isAES = enc === ENC.AES;

    const cstr = (off) => { const e = nam.indexOf(0, off); return nam.toString('latin1', off, e < 0 ? nam.length : e); };
    for (let i = 0; i < count; i++) {
      const o = i * 16, x = ent.readUInt32LE(o + 4);
      let e;
      if (x === 0x7fffff00) {
        e = { kind: 'dir', nameOffset: ent.readUInt32LE(o), index: ent.readUInt32LE(o + 8), count: ent.readUInt32LE(o + 12) };
      } else if ((x & 0x80000000) === 0) {
        const lo = ent.readUInt32LE(o), hi = ent.readUInt32LE(o + 4);
        e = {
          kind: 'bin', nameOffset: lo & 0xffff, size: ((lo >>> 16) | ((hi & 0xff) << 16)) & 0xffffff,
          offset: (hi >>> 8) & 0xffffff, uncompressed: ent.readUInt32LE(o + 8), encrypted: ent.readUInt32LE(o + 12) === 1,
        };
      } else {
        e = {
          kind: 'res', nameOffset: ent.readUInt16LE(o),
          size: ent[o + 2] | (ent[o + 3] << 8) | (ent[o + 4] << 16),
          offset: (ent[o + 5] | (ent[o + 6] << 8) | (ent[o + 7] << 16)) & 0x7fffff,
          sflags: ent.readUInt32LE(o + 8), gflags: ent.readUInt32LE(o + 12),
        };
      }
      e.name = cstr(e.nameOffset).slice(0, 256);
      e.lower = e.name.toLowerCase();
      this.entries.push(e);
    }
    // resolve directory structure -> paths
    const root = this.entries[0];
    root.path = this.path;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      for (let i = d.index; i < d.index + d.count && i < this.entries.length; i++) {
        const c = this.entries[i];
        c.parent = d;
        c.path = d.path + '/' + c.lower;
        if (c.kind === 'dir') stack.push(c);
      }
    }
  }

  /** Nested .rpf entries as Rpf objects. */
  children(filter) {
    const out = [];
    for (const e of this.entries) {
      if (e.kind !== 'bin' || !e.lower.endsWith('.rpf')) continue;
      if (filter && !filter(e)) continue;
      try {
        const size = e.size === 0 ? e.uncompressed : e.size;
        out.push(new Rpf(this.crypto, this.src, this.base + e.offset * 512, e.name, size, e.path));
      } catch { /* damaged / modded archive: skip */ }
    }
    return out;
  }

  /** File contents. Resources come back as { buf, sflags, gflags } (inflated, header stripped). */
  extract(e) {
    const pos = this.base + e.offset * 512;
    if (e.kind === 'bin') {
      const len = e.size === 0 ? e.uncompressed : e.size;
      let data = this.src.read(pos, len);
      if (e.encrypted) data = this.isAES ? this.crypto.decryptAES(data) : this.crypto.decryptNG(data, e.name, e.uncompressed);
      return e.size > 0 ? zlib.inflateRawSync(data) : data;
    }
    if (e.kind === 'res') {
      let size = e.size;
      if (size === 0xffffff) {
        const h = this.src.read(pos, 16);
        size = (h[7] | (h[14] << 8) | (h[5] << 16) | (h[2] << 24)) >>> 0;
      }
      let data = this.src.read(pos + 16, size - 16);
      if (e.lower.endsWith('.ysc')) data = this.isAES ? this.crypto.decryptAES(data) : this.crypto.decryptNG(data, e.name, size);
      let buf;
      try { buf = zlib.inflateRawSync(data); } catch { buf = data; }
      return { buf, sflags: e.sflags, gflags: e.gflags };
    }
    throw new Error('not a file');
  }
}

/** Open the GTA V root archives. */
function openGta(gtaDir, crypto) {
  const path = require('path');
  const files = [];
  for (const f of fs.readdirSync(gtaDir)) if (/\.rpf$/i.test(f)) files.push(path.join(gtaDir, f));
  const upd = path.join(gtaDir, 'update');
  if (fs.existsSync(upd)) for (const f of fs.readdirSync(upd)) if (/\.rpf$/i.test(f)) files.push(path.join(upd, f));
  const out = [];
  for (const f of files) {
    try {
      const src = new FileSource(f);
      out.push(new Rpf(crypto, src, 0, path.basename(f), src.size, ''));
    } catch { /* skip unreadable */ }
  }
  return out;
}

module.exports = { Crypto, Rpf, FileSource, openGta };
