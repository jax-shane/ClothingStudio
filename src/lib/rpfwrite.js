'use strict';
// RPF7 writer: packs files into a GTA V archive. rpf.js reads these (and the game's own archives); this writes them.
//
// The result is an "OPEN" archive: nothing in it is encrypted, which is what OpenIV and CodeWalker write for mods. The layout
// follows what was measured in the game's own clothing DLC archives:
//   header (16 bytes) + 16 bytes per entry + the names table (padded to a multiple of 16), then the data;
//   entry 0 is the root folder; the children of a folder are contiguous and sorted by lower-case name, and each sub-folder's
//   children follow depth first (the same table order as the game's own archives, checked by rewriting real ones);
//   every file starts on a 512-byte block, the data is back to back, and the archive ends on a block boundary.
// Three kinds of entry: nested .rpf archives and plain files ("bin", deflated when that is smaller), and resources
// (anything that starts with the RSC7 header: .ydd .ytd .ymt .yld ...), which are stored as they are, with their page
// flags copied into the table.

const zlib = require('zlib');

const RPF7 = 0x52504637;
const OPEN = 0x4e45504f;
const RSC7 = 0x37435352;
const BLOCK = 512;
const DIR_MARK = 0x7fffff00;
const BIG = 0xffffff;                       // a table size field holds 24 bits: bigger resources keep their real size in the stored header

const lower = (s) => s.toLowerCase();
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * files: [{ path: 'folder/sub/file.ext', data: Buffer }] (folders are implied). Returns the archive as a Buffer.
 * A file whose name ends in .rpf is stored as a nested archive (its data must already be an archive made by this function).
 */
function writeRpf(files) {
  // ---- the tree
  const root = { name: '', dir: true, kids: new Map() };
  for (const f of files) {
    const parts = String(f.path).split('/').filter(Boolean);
    if (!parts.length) throw new Error('a file needs a name');
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = lower(parts[i]);
      let c = d.kids.get(key);
      if (!c) { c = { name: parts[i], dir: true, kids: new Map() }; d.kids.set(key, c); }
      else if (!c.dir) throw new Error(`${parts.slice(0, i + 1).join('/')} is both a file and a folder`);
      d = c;
    }
    const leaf = parts[parts.length - 1], key = lower(leaf);
    if (d.kids.has(key)) throw new Error('the archive would hold ' + f.path + ' twice');
    if (!Buffer.isBuffer(f.data)) throw new Error(f.path + ' has no data');
    d.kids.set(key, { name: leaf, dir: false, data: f.data });
  }

  // ---- table order: a folder's children are listed together (sorted), then each sub-folder's children, depth first
  const order = [root];
  const emit = (n) => {
    const kids = [...n.kids.entries()].sort((a, b) => cmp(a[0], b[0])).map((e) => e[1]);
    n.index = order.length; n.count = kids.length;
    for (const k of kids) order.push(k);
    for (const k of kids) if (k.dir) emit(k);
  };
  emit(root);

  // ---- names table (the root's name is empty); equal names are stored once
  const chunks = [], at = new Map();
  let namesLen = 0;
  for (const n of order) {
    if (at.has(n.name)) { n.nameOffset = at.get(n.name); continue; }
    const b = Buffer.from(n.name + '\0', 'latin1');
    n.nameOffset = namesLen; at.set(n.name, namesLen); chunks.push(b); namesLen += b.length;
  }
  const namesPadded = Math.ceil(namesLen / 16) * 16;
  for (const n of order) if (!n.dir && n.nameOffset > 0xffff) throw new Error('too many files (or names too long) for one archive: split the pack');

  // ---- how each file is stored
  const count = order.length;
  let block = Math.ceil((16 + count * 16 + namesPadded) / BLOCK);
  for (const n of order) {
    if (n.dir) continue;
    const d = n.data;
    if (/\.rpf$/i.test(n.name)) {
      if (d.length % BLOCK || d.length < 16 || d.readUInt32LE(0) !== RPF7) throw new Error(n.name + ' is not an archive made by writeRpf');
      Object.assign(n, { kind: 'bin', stored: d, size: 0, unc: d.length });
    } else if (d.length >= 16 && d.readUInt32LE(0) === RSC7) {
      let stored = d, size = d.length;
      if (size >= BIG) {                                   // the real size goes into the stored header, the table says "big"
        stored = Buffer.from(d);
        stored[7] = size & 0xff; stored[14] = (size >>> 8) & 0xff; stored[5] = (size >>> 16) & 0xff; stored[2] = (size >>> 24) & 0xff;
        size = BIG;
      }
      Object.assign(n, { kind: 'res', stored, size, sflags: d.readUInt32LE(8), gflags: d.readUInt32LE(12) });
    } else {
      const z = d.length ? zlib.deflateRawSync(d, { level: 9 }) : null;
      if (z && z.length < d.length && z.length < BIG) Object.assign(n, { kind: 'bin', stored: z, size: z.length, unc: d.length });
      else Object.assign(n, { kind: 'bin', stored: d, size: 0, unc: d.length });
    }
    n.block = block;
    block += Math.ceil(n.stored.length / BLOCK);
    if (block >= 0x800000) throw new Error('the archive would be bigger than 4 GB');
  }

  // ---- write
  const out = Buffer.alloc(block * BLOCK);
  out.writeUInt32LE(RPF7, 0); out.writeUInt32LE(count, 4); out.writeUInt32LE(namesPadded, 8); out.writeUInt32LE(OPEN, 12);
  order.forEach((n, i) => {
    const o = 16 + i * 16;
    if (n.dir) {
      out.writeUInt32LE(n.nameOffset, o); out.writeUInt32LE(DIR_MARK, o + 4); out.writeUInt32LE(n.index, o + 8); out.writeUInt32LE(n.count, o + 12);
    } else if (n.kind === 'bin') {
      out.writeUInt32LE(((n.nameOffset & 0xffff) | ((n.size & 0xffff) << 16)) >>> 0, o);
      out.writeUInt32LE(((n.block << 8) | ((n.size >>> 16) & 0xff)) >>> 0, o + 4);
      out.writeUInt32LE(n.unc >>> 0, o + 8); out.writeUInt32LE(0, o + 12);
    } else {
      out.writeUInt16LE(n.nameOffset, o);
      out[o + 2] = n.size & 0xff; out[o + 3] = (n.size >>> 8) & 0xff; out[o + 4] = (n.size >>> 16) & 0xff;
      const off = (n.block | 0x800000) >>> 0;
      out[o + 5] = off & 0xff; out[o + 6] = (off >>> 8) & 0xff; out[o + 7] = (off >>> 16) & 0xff;
      out.writeUInt32LE(n.sflags >>> 0, o + 8); out.writeUInt32LE(n.gflags >>> 0, o + 12);
    }
    if (!n.dir) n.stored.copy(out, n.block * BLOCK);
  });
  Buffer.concat(chunks).copy(out, 16 + count * 16);
  return out;
}

module.exports = { writeRpf, RPF7, OPEN, BLOCK };
