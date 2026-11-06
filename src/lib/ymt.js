'use strict';
// Reader / writer for the ped variation .ymt of a clothing pack (CPedVariationInfo, an RSC7 "Meta" resource).
// It tells the game, per component slot and drawable, how many textures exist (a, b, c ...), plus audio/flag data
// and the prop tables. The writer reproduces what CodeWalker's MetaBuilder / grzyClothTool produce: one data block
// per structure type, items padded to 16 bytes, arrays referenced by (block id, offset) pointers.
// Layout knowledge: CodeWalker (dexyfex, GPL-3.0) - see the README credits.

const fs = require('fs');
const zlib = require('zlib');
const { loadRsc } = require('./rsc');
const TYPES = require('./ymt_types.json');

function joaat(s) {
  let h = 0;
  for (const c of Buffer.from(s, 'latin1')) { h = (h + c) >>> 0; h = (h + (h << 10)) >>> 0; h ^= h >>> 6; h >>>= 0; }
  h = (h + (h << 3)) >>> 0; h ^= h >>> 11; h >>>= 0; h = (h + (h << 15)) >>> 0;
  return h >>> 0;
}

// block (structure) hashes, matched against the structure table in the asset so they always agree with the file format
const known = new Set(TYPES.structs.map((s) => s.hash));
const nameHash = (n) => [joaat(n.toLowerCase()), joaat(n)].find((h) => known.has(h));
const H = {
  VARINFO: nameHash('CPedVariationInfo'), TEX: nameHash('CPVTextureData'), DRAWBL: nameHash('CPVDrawblData'),
  COMP: nameHash('CPVComponentData'), COMPINFO: nameHash('CComponentInfo'), PROPTEX: nameHash('CPedPropTexData'),
  PROP: nameHash('CPedPropMetaData'), ANCHOR: nameHash('CAnchorProps'), BYTE: 0x11,
};
const KNOWN_BLOCKS = new Set(Object.values(H));

// struct sizes
const SZ = { root: 0x70, comp: 0x18, drawbl: 0x30, tex: 3, compInfo: 0x30, prop: 0x38, propTex: 0xc, anchor: 0x18 };

const COMP_SLOT = { head: 0, berd: 1, hair: 2, uppr: 3, lowr: 4, hand: 5, feet: 6, teef: 7, accs: 8, task: 9, decl: 10, jbib: 11 };
const PROP_SLOT = {
  p_head: 0, p_eyes: 1, p_ears: 2, p_mouth: 3, p_lhand: 4, p_rhand: 5, p_lwrist: 6, p_rwrist: 7,
  p_hip: 8, p_lfoot: 9, p_rfoot: 10, p_ph_l_hand: 11, p_ph_r_hand: 12,
};

// ------------------------------------------------------------------ read
function readYmt(file) {
  const rsc = loadRsc(file);
  const buf = rsc.buf;
  if (rsc.version !== 2) throw new Error('not a ped variation .ymt (wrong resource version)');
  if (buf.length < 0x90) throw new Error('truncated .ymt');
  const seg = (o) => buf.readUInt32LE(o) & 0x0fffffff;

  const nDB = buf.readInt16LE(0x4c), dbOff = seg(0x30), rootId = buf.readInt32LE(0x1c);
  const blocks = [];
  for (let i = 0; i < nDB; i++) {
    const o = dbOff + i * 16;
    const b = { hash: buf.readUInt32LE(o), len: buf.readInt32LE(o + 4), off: seg(o + 8) };
    if (!KNOWN_BLOCKS.has(b.hash)) throw new Error('this .ymt contains data this app cannot rewrite safely (block 0x' + b.hash.toString(16) + ')');
    if (b.off + b.len > buf.length) throw new Error('corrupt .ymt (block outside the file)');
    blocks.push(b);
  }
  const root = blocks[rootId - 1];
  if (!root || root.hash !== H.VARINFO || root.len < SZ.root) throw new Error('this .ymt has no CPedVariationInfo');
  const nameOff = seg(0x38), nameEnd = buf.indexOf(0, nameOff);
  const name = nameOff && nameEnd > nameOff ? buf.toString('latin1', nameOff, nameEnd) : '';

  // An Array_Structure at file offset o: pointer (block id in the low 12 bits, byte offset above), count, count.
  // Returns where its items start in the file.
  const ref = (o, stride, hash) => {
    const ptr = buf.readUInt32LE(o), count = buf.readUInt16LE(o + 8);
    if (!ptr || !count) return { count: 0, base: 0 };
    const b = blocks[(ptr & 0xfff) - 1], off = ptr >>> 12;
    if (!b || b.hash !== hash) throw new Error('unexpected array target in the .ymt');
    if (off + count * stride > b.len) throw new Error('corrupt .ymt (array outside its block)');
    return { count, base: b.off + off };
  };
  const items = (r, stride) => Array.from({ length: r.count }, (_, i) => Buffer.from(buf.subarray(r.base + i * stride, r.base + (i + 1) * stride)));

  if (buf.readUInt16LE(root.off + 0x28) !== 0) throw new Error('this .ymt uses a field this app does not handle (extra array in the root)');

  const compRef = ref(root.off + 0x10, SZ.comp, H.COMP);
  const comps = items(compRef, SZ.comp).map((raw, i) => {
    const drawRef = ref(compRef.base + i * SZ.comp + 8, SZ.drawbl, H.DRAWBL);
    const drawables = items(drawRef, SZ.drawbl).map((draw, d) => ({
      raw: draw, tex: items(ref(drawRef.base + d * SZ.drawbl + 8, SZ.tex, H.TEX), SZ.tex),
    }));
    return { raw, drawables };
  });
  const compInfos = items(ref(root.off + 0x30, SZ.compInfo, H.COMPINFO), SZ.compInfo);

  const propRef = ref(root.off + 0x48, SZ.prop, H.PROP);
  const props = items(propRef, SZ.prop).map((raw, i) => ({
    raw, tex: items(ref(propRef.base + i * SZ.prop + 0x18, SZ.propTex, H.PROPTEX), SZ.propTex),
  }));
  const anchorRef = ref(root.off + 0x58, SZ.anchor, H.ANCHOR);
  const anchors = items(anchorRef, SZ.anchor).map((raw, i) => {
    const r = ref(anchorRef.base + i * SZ.anchor, 1, H.BYTE);
    return { raw, bytes: r.count ? [...buf.subarray(r.base, r.base + r.count)] : [] };
  });

  const rootRaw = Buffer.from(buf.subarray(root.off, root.off + SZ.root));
  comps.forEach((c, i) => { c.slot = rootRaw.subarray(4, 16).indexOf(i); });   // availComp maps slot -> index; keep the slot on the component
  if (comps.some((c) => c.slot < 0)) throw new Error('this .ymt has a component that no slot points to');
  return { name, rootRaw, comps, compInfos, props, anchors };
}

// ------------------------------------------------------------------ editing the model
const NONE_HASH = joaat('none');     // default audio hash used by grzyClothTool
const MAX_DRAWABLES = 256;           // numbers 000-255

/** a ymt with no pieces yet (for a brand new pack) */
function createModel(dlcName) {
  const root = Buffer.alloc(SZ.root);
  root[0] = 1; root[1] = 1;                                        // bHasTexVariations, bHasDrawblVariations
  root.fill(255, 4, 16);                                           // availComp: no components yet
  const m = { name: dlcName, rootRaw: root, comps: [], compInfos: [], props: [], anchors: [] };
  setDlcName(m, dlcName);
  return m;
}

function setDlcName(model, dlcName) {
  model.name = dlcName;
  model.rootRaw.writeUInt32LE(joaat(String(dlcName).toLowerCase()), 0x68);
}

/**
 * Bring the derived data back in line after any edit: components sorted by slot (with availComp rebuilt),
 * per-component texture totals, compInfos / props / anchors sorted and complete, prop count.
 */
function normalize(model) {
  model.comps.sort((a, b) => a.slot - b.slot);
  model.rootRaw.fill(255, 4, 16);
  model.comps.forEach((c, i) => { model.rootRaw[4 + c.slot] = i; c.raw[0] = Math.min(255, c.drawables.reduce((n, d) => n + d.tex.length, 0)); });
  // compInfos and props keep the order they have (the game looks entries up by slot + number, and grzyClothTool's own
  // files are not sorted either); new entries were appended at the end by the edit functions
  model.props.forEach((p) => p.tex.forEach((t, i) => { t[8] = i; }));
  model.rootRaw[0x40] = Math.min(255, model.props.length);
  const used = [...new Set(model.props.map((p) => p.raw[0x32]))];
  const old = new Map(model.anchors.map((a) => [a.raw.readUInt32LE(0x10), a]));
  const ids = [...model.anchors.map((a) => a.raw.readUInt32LE(0x10)).filter((id) => used.includes(id)), ...used.filter((id) => !old.has(id))];
  model.anchors = ids.map((id) => {
    const a = old.get(id) || { raw: Buffer.alloc(SZ.anchor), bytes: [] };
    a.raw.writeUInt32LE(id, 0x10);
    // the list is indexed by prop number, whatever order the props are stored in
    a.bytes = model.props.filter((p) => p.raw[0x32] === id).sort((p, q) => p.raw[0x33] - q.raw[0x33]).map((p) => Math.min(255, p.tex.length));
    return a;
  });
  return model;
}

const compInfoRaw = (slot, number) => {
  const b = Buffer.alloc(SZ.compInfo);
  b.writeUInt32LE(NONE_HASH, 0); b.writeUInt32LE(NONE_HASH, 4);   // audioID, audioID2 = "none"
  b[0x2c] = slot; b[0x2d] = number;
  return b;
};
const newCompTex = (hasSkin) => Buffer.from([hasSkin ? 1 : 0, 255, 0]);
const newPropTex = (i) => { const b = Buffer.alloc(SZ.propTex); b[8] = i; b[11] = 255; return b; };

/** Renumber the entries of one slot after the drawable numbers changed: map(oldNumber) -> newNumber (or -1 = gone). */
function remapNumbers(model, prop, slot, map) {
  if (prop) {
    model.props = model.props.filter((p) => {
      if (p.raw[0x32] !== slot) return true;
      const n = map(p.raw[0x33]);
      if (n < 0) return false;
      p.raw[0x33] = n; return true;
    });
  } else {
    model.compInfos = model.compInfos.filter((c) => {
      if (c[0x2c] !== slot) return true;
      const n = map(c[0x2d]);
      if (n < 0) return false;
      c[0x2d] = n; return true;
    });
  }
}

/** Add a piece at `index` (default: the end); later pieces move up one number. spec: { hasSkin, texCount } */
function insertDrawable(model, prop, slot, index, spec = {}) {
  const texCount = Math.max(0, spec.texCount | 0);
  if (prop) {
    const count = model.props.filter((p) => p.raw[0x32] === slot).length;
    index = index == null ? count : index;
    if (count >= MAX_DRAWABLES) throw new Error('A prop slot holds at most 256 pieces.');
    remapNumbers(model, true, slot, (n) => (n >= index ? n + 1 : n));
    const raw = Buffer.alloc(SZ.prop);
    raw.writeUInt32LE(NONE_HASH, 0); raw[0x32] = slot; raw[0x33] = index;
    model.props.push({ raw, tex: Array.from({ length: texCount }, (_, i) => newPropTex(i)) });
  } else {
    const comp = ensureComp(model, slot);
    index = index == null ? comp.drawables.length : index;
    if (comp.drawables.length >= MAX_DRAWABLES) throw new Error('A component slot holds at most 256 pieces.');
    remapNumbers(model, false, slot, (n) => (n >= index ? n + 1 : n));
    const raw = Buffer.alloc(SZ.drawbl);
    raw[0] = spec.hasSkin ? 17 : 1;                                // propMask
    comp.drawables.splice(index, 0, { raw, tex: Array.from({ length: texCount }, () => newCompTex(spec.hasSkin)) });
    model.compInfos.push(compInfoRaw(slot, index));
  }
  return normalize(model);
}

function ensureComp(model, slot) {
  let c = model.comps.find((x) => x.slot === slot);
  if (!c) { c = { raw: Buffer.alloc(SZ.comp), drawables: [], slot }; model.comps.push(c); }
  return c;
}

/** Remove a piece; the pieces after it move down one number. */
function removeDrawable(model, prop, slot, index) {
  if (prop) {
    const count = model.props.filter((p) => p.raw[0x32] === slot).length;
    if (index < 0 || index >= count) throw new Error('No such prop in the .ymt');
    remapNumbers(model, true, slot, (n) => (n === index ? -1 : n > index ? n - 1 : n));
  } else {
    const comp = model.comps.find((x) => x.slot === slot);
    if (!comp || index < 0 || index >= comp.drawables.length) throw new Error('No such component piece in the .ymt');
    comp.drawables.splice(index, 1);
    remapNumbers(model, false, slot, (n) => (n === index ? -1 : n > index ? n - 1 : n));
    if (!comp.drawables.length) model.comps = model.comps.filter((c) => c !== comp);      // an empty component disappears
  }
  return normalize(model);
}

/** Move a piece from one number to another; the ones in between shift by one. (Moving 002 to 001 swaps them.) */
function moveDrawable(model, prop, slot, from, to) {
  if (from === to) return model;
  const shift = (n) => (n === from ? to : from < to ? (n > from && n <= to ? n - 1 : n) : (n >= to && n < from ? n + 1 : n));
  if (prop) {
    const count = model.props.filter((p) => p.raw[0x32] === slot).length;
    if (from < 0 || to < 0 || from >= count || to >= count) throw new Error('Move target is outside the pieces of this slot');
    remapNumbers(model, true, slot, shift);
  } else {
    const comp = model.comps.find((x) => x.slot === slot);
    if (!comp || from < 0 || to < 0 || from >= comp.drawables.length || to >= comp.drawables.length) throw new Error('Move target is outside the pieces of this slot');
    const [d] = comp.drawables.splice(from, 1);
    comp.drawables.splice(to, 0, d);
    remapNumbers(model, false, slot, shift);
  }
  return normalize(model);
}

// ------------------------------------------------------------------ write
class Builder {
  constructor() { this.blocks = []; }
  ensure(hash) {
    for (const b of this.blocks) if (b.hash === hash && b.size < 0x4000) return b;   // MetaBuilder starts a new block at 16 KB
    const nb = { hash, parts: [], size: 0, index: this.blocks.length };
    this.blocks.push(nb);
    return nb;
  }
  /** items are concatenated, the array is padded to 16 bytes; returns { block (1-based), offset, count } */
  array(hash, data, count) {
    const b = this.ensure(hash);
    const padded = Buffer.alloc(Math.ceil(data.length / 16) * 16);
    data.copy(padded);
    const offset = b.size;
    b.parts.push(padded); b.size += padded.length;
    return { block: b.index + 1, offset, count };
  }
}

function putArray(buf, o, a) {
  buf.fill(0, o, o + 16);
  if (!a || !a.count) return;
  buf.writeUInt32LE(((a.block & 0xfff) + (a.offset & 0xfffff) * 4096) >>> 0, o);
  buf.writeUInt16LE(a.count, o + 8);
  buf.writeUInt16LE(a.count, o + 10);
}

function buildYmt(model) {
  normalize(model);
  const B = new Builder();
  const rootBlock = B.ensure(H.VARINFO);                       // block 1, the root structure
  const root = Buffer.from(model.rootRaw);

  // same order grzyClothTool builds in: textures of each drawable, then that component's drawables, then the components
  const compItems = [];
  for (const c of model.comps) {
    const drawItems = [];
    for (const d of c.drawables) {
      const dr = Buffer.from(d.raw);
      putArray(dr, 8, d.tex.length ? B.array(H.TEX, Buffer.concat(d.tex), d.tex.length) : null);
      drawItems.push(dr);
    }
    const cd = Buffer.from(c.raw);
    putArray(cd, 8, drawItems.length ? B.array(H.DRAWBL, Buffer.concat(drawItems), drawItems.length) : null);
    compItems.push(cd);
  }
  putArray(root, 0x10, compItems.length ? B.array(H.COMP, Buffer.concat(compItems), compItems.length) : null);
  putArray(root, 0x30, model.compInfos.length ? B.array(H.COMPINFO, Buffer.concat(model.compInfos), model.compInfos.length) : null);

  const propItems = [];
  for (const p of model.props) {
    const pr = Buffer.from(p.raw);
    putArray(pr, 0x18, p.tex.length ? B.array(H.PROPTEX, Buffer.concat(p.tex), p.tex.length) : null);
    propItems.push(pr);
  }
  root[0x40] = Math.min(255, model.props.length);               // numAvailProps
  putArray(root, 0x48, propItems.length ? B.array(H.PROP, Buffer.concat(propItems), propItems.length) : null);

  const anchorItems = [];
  for (const a of model.anchors) {
    const an = Buffer.from(a.raw);
    putArray(an, 0, a.bytes.length ? B.array(H.BYTE, Buffer.from(a.bytes), a.bytes.length) : null);
    anchorItems.push(an);
  }
  putArray(root, 0x58, anchorItems.length ? B.array(H.ANCHOR, Buffer.concat(anchorItems), anchorItems.length) : null);

  rootBlock.parts = [Buffer.concat([root, Buffer.alloc(Math.ceil(root.length / 16) * 16 - root.length)])];
  rootBlock.size = rootBlock.parts[0].length;
  if (B.blocks.some((b) => b.size === 0)) throw new Error('internal error: empty block in the .ymt builder');

  // ---- lay the file out exactly like the files CodeWalker / grzyClothTool write (so an unchanged .ymt comes out
  // byte-for-byte the same): header (0x90), the structure table from 0x1090, enum table, block table, data blocks, name
  const header = Buffer.from(TYPES.header, 'base64');             // 0x90 bytes: Meta header + pages info
  let pos = 0x1090;
  const place = (len, align = 16) => { pos = Math.ceil(pos / align) * align; const o = pos; pos += len; return o; };

  const siOff = place(TYPES.structs.length * 32);
  const siEntryOffs = TYPES.structs.map((s) => place(s.entries.length * 16));
  const eiOff = place(TYPES.enums.length * 24);
  const eiEntryOffs = TYPES.enums.map((e) => place(e.entries.length * 8));
  const dbOff = place(B.blocks.length * 16);
  const dataOffs = B.blocks.map((b) => place(b.size));
  const nameBytes = Buffer.from((model.name || '') + '\0', 'latin1');
  const nameOff = place(nameBytes.length);

  let unit = 0x200 << 4, shift = 4;                                // at least 8 KB, like the originals
  while (unit < pos) { unit *= 2; shift += 1; }
  const out = Buffer.alloc(unit);
  header.copy(out, 0);

  const P = (o) => 0x50000000 + o;
  const w64 = (o, v) => { out.writeUInt32LE(v >>> 0, o); out.writeUInt32LE(0, o + 4); };
  out.writeInt32LE(1, 0x1c);                                       // the root block is block 1
  w64(0x20, P(siOff)); w64(0x28, P(eiOff)); w64(0x30, P(dbOff)); w64(0x38, P(nameOff)); w64(0x40, 0);
  out.writeInt16LE(TYPES.structs.length, 0x48); out.writeInt16LE(TYPES.enums.length, 0x4a); out.writeInt16LE(B.blocks.length, 0x4c);

  TYPES.structs.forEach((s, i) => {
    const o = siOff + i * 32;
    out.writeUInt32LE(s.hash, o); out.writeUInt32LE(s.key, o + 4); out.writeUInt32LE(s.unk8, o + 8); out.writeUInt32LE(s.unkC, o + 12);
    w64(o + 16, P(siEntryOffs[i])); out.writeInt32LE(s.size, o + 24); out.writeInt16LE(s.unk1C, o + 28); out.writeInt16LE(s.entries.length, o + 30);
    s.entries.forEach((e, j) => {
      const eo = siEntryOffs[i] + j * 16;
      out.writeUInt32LE(e[0], eo); out.writeInt32LE(e[1], eo + 4); out[eo + 8] = e[2]; out[eo + 9] = e[3];
      out.writeInt16LE(e[4], eo + 10); out.writeUInt32LE(e[5], eo + 12);
    });
  });
  TYPES.enums.forEach((en, i) => {
    const o = eiOff + i * 24;
    out.writeUInt32LE(en.hash, o); out.writeUInt32LE(en.key, o + 4); w64(o + 8, P(eiEntryOffs[i]));
    out.writeInt32LE(en.entries.length, o + 16); out.writeInt32LE(en.unk14, o + 20);
    en.entries.forEach((e, j) => { out.writeUInt32LE(e[0], eiEntryOffs[i] + j * 8); out.writeInt32LE(e[1], eiEntryOffs[i] + j * 8 + 4); });
  });
  B.blocks.forEach((b, i) => {
    const o = dbOff + i * 16;
    out.writeUInt32LE(b.hash, o); out.writeInt32LE(b.size, o + 4); w64(o + 8, P(dataOffs[i]));
    Buffer.concat(b.parts).copy(out, dataOffs[i]);
  });
  nameBytes.copy(out, nameOff);

  const head = Buffer.alloc(16);
  head.write('RSC7', 0, 'latin1');
  head.writeUInt32LE(TYPES.version, 4);
  head.writeUInt32LE((0x08000000 | shift) >>> 0, 8);               // one system page of 0x200 << shift bytes
  head.writeUInt32LE(TYPES.gflags >>> 0, 12);
  return Buffer.concat([head, zlib.deflateRawSync(out, { level: 9 })]);
}

// ------------------------------------------------------------------ compare with the files in a pack
function locate(model, item) {
  const d = parseInt(item.drawable, 10);
  if (item.prop) {
    const slot = PROP_SLOT[item.comp];
    const p = model.props.find((x) => x.raw[0x32] === slot && x.raw[0x33] === d);
    return p ? { kind: 'prop', p } : null;
  }
  const slot = COMP_SLOT[item.comp];
  if (slot === undefined) return null;
  const idx = model.rootRaw[4 + slot];                              // availComp: component slot -> index into comps (0xFF = none)
  const comp = model.comps[idx];
  const dr = comp && comp.drawables[d];
  return dr ? { kind: 'comp', comp, d: dr } : null;
}

const texCount = (loc) => (loc.kind === 'prop' ? loc.p.tex.length : loc.d.tex.length);

/**
 * List every piece that has files but is missing from the model, in number order (only where its number is the next
 * free one - a gap in the numbering is left alone and stays reported as missing). Returns the pieces that were added.
 */
function ensureListed(model, items) {
  const groups = new Map(), added = [];
  for (const it of items) {
    if (!it.variants || !it.variants.length) continue;
    const k = `${!!it.prop}|${it.comp}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(it);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => +a.drawable - +b.drawable);
    for (const it of list) {
      if (locate(model, it)) continue;
      const slot = it.prop ? PROP_SLOT[it.comp] : COMP_SLOT[it.comp];
      if (slot === undefined) continue;
      const have = it.prop ? model.props.filter((p) => p.raw[0x32] === slot).length : (model.comps.find((c) => c.slot === slot) || { drawables: [] }).drawables.length;
      if (+it.drawable !== have) continue;
      insertDrawable(model, !!it.prop, slot, +it.drawable, { hasSkin: (it.race || '').toLowerCase() === 'r', texCount: it.variants.length });
      added.push(it);
    }
  }
  return added;
}

/** items: pack items of ONE gender. Returns { diffs: [{id,label,group,have,want}], missing: [{id,label}] } */
function compare(model, items) {
  const diffs = [], missing = [];
  for (const it of items) {
    if (!it.variants || !it.variants.length) continue;
    const loc = locate(model, it);
    if (!loc) { missing.push({ id: it.id, label: it.label, group: it.group }); continue; }
    const have = texCount(loc), want = it.variants.length;
    if (have !== want) diffs.push({ id: it.id, label: it.label, group: it.group, have, want });
  }
  return { diffs, missing };
}

/** Make the texture counts in the model match the files (only: restrict to one piece id). Returns the changes made. */
function applyCounts(model, items, only) {
  const changes = [];
  for (const it of items) {
    if (!it.variants || !it.variants.length || (only && it.id !== only)) continue;
    const loc = locate(model, it);
    if (!loc) continue;
    const want = it.variants.length, have = texCount(loc);
    if (loc.kind === 'comp') {
      const tex = loc.d.tex;
      const skin = (loc.d.raw[0] >> 4) & 1;                          // propMask bit 4 (has skin) -> texId 1
      while (tex.length > want) tex.pop();
      while (tex.length < want) tex.push(tex.length ? Buffer.from(tex[tex.length - 1]) : Buffer.from([skin, 255, 0]));
      loc.comp.raw[0] = Math.min(255, loc.comp.drawables.reduce((n, x) => n + x.tex.length, 0));   // numAvailTex of the component
    } else {
      const tex = loc.p.tex;
      while (tex.length > want) tex.pop();
      while (tex.length < want) {
        tex.push(tex.length ? Buffer.from(tex[tex.length - 1]) : Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255]));
      }
      tex.forEach((t, i) => { t[8] = i; });                          // props number their textures 0, 1, 2 ...
    }
    if (have !== want) changes.push({ id: it.id, label: it.label, from: have, to: want });
  }
  normalize(model);                                                  // totals and the per-anchor texture lists
  return changes;
}

// ------------------------------------------------------------------ per-piece options (audio, flags, render flag, hair scale, heels, skin)
const OPT = require('./options');
const AUDIO_NAME = new Map();                                       // hash -> name, for every audio name we offer
for (const list of Object.values(OPT.AUDIO)) for (const n of list) AUDIO_NAME.set(joaat(n), n);

function compInfoOf(model, slot, number, create) {
  let ci = model.compInfos.find((c) => c[0x2c] === slot && c[0x2d] === number);
  if (!ci && create) { ci = compInfoRaw(slot, number); model.compInfos.push(ci); }
  return ci || null;
}

/**
 * What the .ymt says about one piece. Comps: audio, flags, hasSkin, heels (feet only). Props: audio, flags, renderFlag,
 * hairScale (hats only). Values the lists do not know are returned as-is (audioHash) so they survive an edit unchanged.
 */
function getOptions(model, item) {
  const loc = locate(model, item);
  if (!loc) return null;
  const o = { kind: loc.kind, comp: item.comp };
  if (loc.kind === 'comp') {
    const slot = COMP_SLOT[item.comp], ci = compInfoOf(model, slot, +item.drawable, false);
    const hash = ci ? ci.readUInt32LE(0) : NONE_HASH;
    o.audioHash = hash; o.audio = AUDIO_NAME.get(hash) || null;
    o.flags = ci ? ci.readUInt32LE(0x1c) : 0;
    o.hasSkin = (loc.d.raw[0] & 16) !== 0;
    if (slot === 6) { const v = ci ? ci.readFloatLE(0x18) : 0; o.heels = { enabled: v !== 0, value: v !== 0 ? v : 1 }; }
  } else {
    const hash = loc.p.raw.readUInt32LE(0);
    o.audioHash = hash; o.audio = AUDIO_NAME.get(hash) || null;
    o.flags = loc.p.raw.readUInt32LE(0x2c);
    const rf = loc.p.raw.readUInt32LE(0x28);
    o.renderFlagValue = rf; o.renderFlag = (OPT.RENDER_FLAGS.find(([, v]) => v === rf) || [null])[0];
    if (PROP_SLOT[item.comp] === 0) { const v = loc.p.raw.readFloatLE(4); o.hairScale = { enabled: v !== 0, value: v !== 0 ? Math.abs(v) : 0.5 }; }
  }
  return o;
}

/** Apply any of: audio (name), flags (number), renderFlag (name), hairScale {enabled,value}, heels {enabled,value}, hasSkin (bool). */
function setOptions(model, item, o) {
  const loc = locate(model, item);
  if (!loc) throw new Error('This piece is not listed in the .ymt.');
  const num = (v, what) => { if (!Number.isFinite(+v)) throw new Error(what + ' must be a number'); return +v; };
  if (loc.kind === 'comp') {
    const slot = COMP_SLOT[item.comp], ci = compInfoOf(model, slot, +item.drawable, true);
    if (o.audio !== undefined) { if (!OPT.audioList(false, item.comp).includes(o.audio)) throw new Error('Unknown audio: ' + o.audio); ci.writeUInt32LE(joaat(o.audio), 0); }
    if (o.flags !== undefined) ci.writeUInt32LE((num(o.flags, 'flags') >>> 0) & 0x1fffff, 0x1c);
    if (o.heels !== undefined && slot === 6) ci.writeFloatLE(o.heels.enabled ? num(o.heels.value, 'heels value') : 0, 0x18);
    if (o.hasSkin !== undefined) {
      loc.d.raw[0] = (loc.d.raw[0] & ~16) | (o.hasSkin ? 16 : 0) | 1;      // propMask: bit 4 = shows skin
      loc.d.tex.forEach((t) => { t[0] = o.hasSkin ? 1 : 0; });
    }
  } else {
    const p = loc.p;
    if (o.audio !== undefined) { if (!OPT.audioList(true, item.comp).includes(o.audio)) throw new Error('Unknown audio: ' + o.audio); p.raw.writeUInt32LE(joaat(o.audio), 0); }
    if (o.flags !== undefined) p.raw.writeUInt32LE((num(o.flags, 'flags') >>> 0) & 0x1fffff, 0x2c);
    if (o.renderFlag !== undefined) {
      const hit = OPT.RENDER_FLAGS.find(([n]) => n === o.renderFlag);
      if (!hit) throw new Error('Unknown render flag: ' + o.renderFlag);
      p.raw.writeUInt32LE(hit[1], 0x28);
    }
    if (o.hairScale !== undefined && PROP_SLOT[item.comp] === 0) p.raw.writeFloatLE(o.hairScale.enabled ? -Math.abs(num(o.hairScale.value, 'hair scale')) : 0, 4);
  }
  return model;
}

/** How many hats / shoes the creature metadata has to cover: all of them when ANY piece uses hair scale / heels, else 0. */
function creatureNeeds(model) {
  const hats = model.props.filter((p) => p.raw[0x32] === 0);
  const feet = model.compInfos.filter((c) => c[0x2c] === 6);
  const shoes = (model.comps.find((c) => c.slot === 6) || { drawables: [] }).drawables.length;
  return {
    hats: hats.some((p) => p.raw.readFloatLE(4) !== 0) ? hats.length : 0,
    heels: feet.some((c) => c.readFloatLE(0x18) !== 0) ? shoes : 0,
  };
}

const digest = (m) => JSON.stringify({
  n: m.name, r: m.rootRaw.toString('hex'),
  c: m.comps.map((c) => [c.raw.toString('hex'), c.drawables.map((d) => [d.raw.toString('hex'), d.tex.map((t) => t.toString('hex'))])]),
  i: m.compInfos.map((x) => x.toString('hex')),
  p: m.props.map((p) => [p.raw.toString('hex'), p.tex.map((t) => t.toString('hex'))]),
  a: m.anchors.map((a) => [a.raw.toString('hex'), a.bytes]),
});

/** Build the file for a model and prove it reads back the same, in memory. Returns the bytes. */
function prepareYmt(model) {
  const bytes = buildYmt(model);
  // the pointers inside the model are rebuilt, so compare the logical content (everything except the pointer fields)
  if (digest(stripPtrs(readYmt(bytes))) !== digest(stripPtrs(model))) throw new Error('verification failed: the rebuilt .ymt does not read back the same');
  return bytes;
}

/** Put prepared bytes on disk: atomic replace, the old file is kept as .bak once (never overwritten). */
function commitYmt(file, bytes, opts = {}) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, bytes);
  const bak = file + '.bak';
  let backup = null;
  if (opts.backup !== false && fs.existsSync(file) && !fs.existsSync(bak)) { fs.copyFileSync(file, bak); backup = bak; }
  fs.renameSync(tmp, file);
  return { file, backup, bytes: bytes.length };
}

/** Write the model to `file`: rebuilt and re-read before it replaces the old file; the old one is kept as .bak once. */
function writeYmt(file, model, opts = {}) {
  return commitYmt(file, prepareYmt(model), opts);
}

/**
 * Copy of a model with every Array_Structure field (pointer + counts, 16 bytes) zeroed, so two files laid out
 * differently compare equal. The item lists themselves are compared, so the counts are still checked.
 */
function stripPtrs(m) {
  const z = (buf, offs) => { const b = Buffer.from(buf); for (const o of offs) b.fill(0, o, o + 16); return b; };
  const root = z(m.rootRaw, [0x10, 0x20, 0x30, 0x48, 0x58]);
  root[0x40] = Math.min(255, m.props.length);                       // numAvailProps is derived from the list
  return {
    name: m.name,
    rootRaw: root,
    comps: m.comps.map((c) => ({ raw: z(c.raw, [8]), drawables: c.drawables.map((d) => ({ raw: z(d.raw, [8]), tex: d.tex })) })),
    compInfos: m.compInfos,
    props: m.props.map((p) => ({ raw: z(p.raw, [0x18]), tex: p.tex })),
    anchors: m.anchors.map((a) => ({ raw: z(a.raw, [0]), bytes: a.bytes })),
  };
}

module.exports = {
  readYmt, buildYmt, prepareYmt, commitYmt, writeYmt, compare, applyCounts, locate, digest, stripPtrs,
  createModel, setDlcName, normalize, insertDrawable, removeDrawable, moveDrawable, ensureListed, getOptions, setOptions, creatureNeeds,
  COMP_SLOT, PROP_SLOT, H,
};
