'use strict';
// Covers src/lib/ymt.js - the ped variation .ymt ("how many textures does each piece have, plus audio / flags / hair
// scale / heels"): building a model from nothing, adding / removing / moving pieces, per-piece options, writing the
// file and reading it back, byte-for-byte stable output, the .bak safety copy, and the comparison with the texture
// files that powers the ".ymt âœ“ / â‰ " chip.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Y = require('../src/lib/ymt');
const { tempDir, cleanup } = require('./helpers');

after(cleanup);

const JBIB = Y.COMP_SLOT.jbib, FEET = Y.COMP_SLOT.feet, HEAD = Y.PROP_SLOT.p_head, EYES = Y.PROP_SLOT.p_eyes;
const num3 = (n) => String(n).padStart(3, '0');

/** a pack-style item (what scanPack returns) - the ymt functions only look at comp / prop / drawable / variants / race */
function piece(comp, n, textures = 1, { prop = false, race = null } = {}) {
  return {
    id: `male_${comp}_${num3(n)}`, label: `${comp} ${num3(n)}`, group: comp, comp, prop, drawable: num3(n), race,
    variants: Array.from({ length: textures }, (_, i) => ({ letter: String.fromCharCode(97 + i) })),
  };
}
const NONE_FLOAT = 0;

/** three tops with 2, 3 and 1 textures; the last one shows skin */
function threeTops() {
  const m = Y.createModel('testdlc');
  Y.insertDrawable(m, false, JBIB, 0, { hasSkin: false, texCount: 2 });
  Y.insertDrawable(m, false, JBIB, 1, { hasSkin: false, texCount: 3 });
  Y.insertDrawable(m, false, JBIB, 2, { hasSkin: true, texCount: 1 });
  return m;
}
const texCounts = (m, slot = JBIB) => m.comps.find((c) => c.slot === slot).drawables.map((d) => d.tex.length);
const audioOf = (m, comp, n) => Y.getOptions(m, piece(comp, n)).audio;

/** a model with a bit of everything: tops, shoes, hats, glasses, with options set */
function richModel() {
  const m = threeTops();
  Y.insertDrawable(m, false, FEET, 0, { hasSkin: true, texCount: 2 });
  Y.insertDrawable(m, false, FEET, 1, { hasSkin: false, texCount: 1 });
  Y.insertDrawable(m, true, HEAD, 0, { texCount: 2 });
  Y.insertDrawable(m, true, HEAD, 1, { texCount: 1 });
  Y.insertDrawable(m, true, EYES, 0, { texCount: 3 });
  Y.setOptions(m, piece('jbib', 1), { audio: 'cloth_upper_sweater', flags: 3 });
  Y.setOptions(m, piece('feet', 0), { audio: 'shoe_high_heels', heels: { enabled: true, value: 1.25 } });
  Y.setOptions(m, piece('p_head', 0, 1, { prop: true }), { renderFlag: 'PRF_CUTOUT', hairScale: { enabled: true, value: 0.35 }, flags: 4096 });
  return m;
}

describe('building a model', () => {
  it('a new model has no pieces and survives being written to a file and read back', () => {
    const dir = tempDir('cs_ymt');
    const file = path.join(dir, 'mp_m_freemode_01_testdlc.ymt');
    const m = Y.createModel('testdlc');
    Y.writeYmt(file, m);
    assert.equal(fs.readFileSync(file).toString('latin1', 0, 4), 'RSC7');
    const back = Y.readYmt(file);
    assert.equal(back.name, 'testdlc');
    assert.equal(back.comps.length, 0);
    assert.equal(back.props.length, 0);
    assert.equal(Y.digest(Y.stripPtrs(back)), Y.digest(Y.stripPtrs(m)));
  });

  it('insertDrawable adds pieces with textures, component info and the "shows skin" marks', () => {
    const m = threeTops();
    assert.equal(m.comps.length, 1);
    assert.equal(m.comps[0].slot, JBIB);
    assert.equal(m.rootRaw[4 + JBIB], 0, 'the availComp table points tops at component 0');
    assert.equal(m.rootRaw[4 + FEET], 255, 'and the other slots at nothing');
    assert.deepEqual(texCounts(m), [2, 3, 1]);
    assert.equal(m.comps[0].raw[0], 6, 'component total = every texture of every piece');
    assert.deepEqual(m.compInfos.map((c) => [c[0x2c], c[0x2d]]), [[JBIB, 0], [JBIB, 1], [JBIB, 2]]);
    assert.deepEqual(m.comps[0].drawables.map((d) => d.raw[0]), [1, 1, 17], 'propMask 17 = shows skin');
    assert.equal(m.comps[0].drawables[2].tex[0][0], 1, 'a skin piece uses texId 1');
    assert.equal(m.comps[0].drawables[0].tex[0][0], 0);
    assert.equal(m.comps[0].drawables[0].tex[0][1], 255);
  });

  it('inserting in the middle pushes the later pieces (and their options) up one number', () => {
    const m = threeTops();
    Y.setOptions(m, piece('jbib', 1), { audio: 'cloth_upper_sweater' });
    Y.insertDrawable(m, false, JBIB, 1, { hasSkin: false, texCount: 4 });
    assert.deepEqual(texCounts(m), [2, 4, 3, 1]);
    assert.equal(audioOf(m, 'jbib', 1), 'none', 'the new piece has the default audio');
    assert.equal(audioOf(m, 'jbib', 2), 'cloth_upper_sweater', 'the old piece 1 is now piece 2');
    assert.equal(m.compInfos.length, 4);
  });

  it('props keep their own numbers, texture numbers, the prop count and the per-anchor texture list', () => {
    const m = Y.createModel('testdlc');
    Y.insertDrawable(m, true, HEAD, 0, { texCount: 2 });
    Y.insertDrawable(m, true, HEAD, 1, { texCount: 3 });
    Y.insertDrawable(m, true, HEAD, 2, { texCount: 1 });
    assert.equal(m.rootRaw[0x40], 3, 'numAvailProps');
    assert.deepEqual(m.props.map((p) => [p.raw[0x32], p.raw[0x33]]), [[HEAD, 0], [HEAD, 1], [HEAD, 2]]);
    assert.deepEqual(m.props[1].tex.map((t) => t[8]), [0, 1, 2], 'textures are numbered 0, 1, 2');
    assert.equal(m.anchors.length, 1);
    assert.deepEqual(m.anchors[0].bytes, [2, 3, 1], 'one entry per prop = its texture count');
    Y.insertDrawable(m, true, HEAD, 0, { texCount: 5 });
    assert.deepEqual(m.anchors[0].bytes, [5, 2, 3, 1]);
  });
});

describe('removing and moving pieces', () => {
  it('removeDrawable closes the gap: later pieces move down a number and take their options with them', () => {
    const m = threeTops();
    Y.setOptions(m, piece('jbib', 2), { audio: 'cloth_upper_shirt_tee' });
    Y.removeDrawable(m, false, JBIB, 1);
    assert.deepEqual(texCounts(m), [2, 1]);
    assert.equal(audioOf(m, 'jbib', 1), 'cloth_upper_shirt_tee');
    assert.equal(m.compInfos.length, 2);
    assert.equal(m.comps[0].raw[0], 3);
    assert.equal(Y.getOptions(m, piece('jbib', 1)).hasSkin, true, 'the skin piece is now number 1');
  });

  it('removing the last piece of a component removes the component', () => {
    const m = Y.createModel('testdlc');
    Y.insertDrawable(m, false, JBIB, 0, { texCount: 1 });
    Y.removeDrawable(m, false, JBIB, 0);
    assert.equal(m.comps.length, 0);
    assert.equal(m.compInfos.length, 0);
    assert.equal(m.rootRaw[4 + JBIB], 255);
  });

  it('removing a prop renumbers the others and rebuilds the anchor list', () => {
    const m = Y.createModel('testdlc');
    for (const n of [2, 3, 4]) Y.insertDrawable(m, true, HEAD, undefined, { texCount: n });
    Y.removeDrawable(m, true, HEAD, 0);
    assert.deepEqual(m.props.map((p) => [p.raw[0x33], p.tex.length]), [[0, 3], [1, 4]]);
    assert.deepEqual(m.anchors[0].bytes, [3, 4]);
    assert.equal(m.rootRaw[0x40], 2);
  });

  it('moveDrawable reorders pieces; textures, audio and skin follow the piece', () => {
    const m = threeTops();                                          // textures 2, 3, 1; piece 2 shows skin
    Y.setOptions(m, piece('jbib', 2), { audio: 'cloth_upper_shirt_tee' });
    Y.moveDrawable(m, false, JBIB, 2, 0);
    assert.deepEqual(texCounts(m), [1, 2, 3]);
    assert.equal(audioOf(m, 'jbib', 0), 'cloth_upper_shirt_tee');
    assert.equal(Y.getOptions(m, piece('jbib', 0)).hasSkin, true);
    assert.equal(audioOf(m, 'jbib', 1), 'none');
    assert.equal(m.compInfos.length, 3);
  });

  it('moving 002 to 001 swaps the two (the "swap with the piece above" button)', () => {
    const m = threeTops();
    Y.moveDrawable(m, false, JBIB, 2, 1);
    assert.deepEqual(texCounts(m), [2, 1, 3]);
    Y.moveDrawable(m, false, JBIB, 1, 1);
    assert.deepEqual(texCounts(m), [2, 1, 3], 'moving to the same place does nothing');
  });

  it('moves props too', () => {
    const m = Y.createModel('testdlc');
    for (const n of [1, 2, 3]) Y.insertDrawable(m, true, HEAD, undefined, { texCount: n });
    Y.moveDrawable(m, true, HEAD, 0, 2);
    const byNumber = [...m.props].sort((a, b) => a.raw[0x33] - b.raw[0x33]);
    assert.deepEqual(byNumber.map((p) => p.tex.length), [2, 3, 1], 'old 0 is now last; the others shifted down');
    assert.deepEqual(m.anchors[0].bytes, [2, 3, 1]);
  });

  it('refuses pieces that are not there', () => {
    const m = threeTops();
    assert.throws(() => Y.removeDrawable(m, false, JBIB, 7), /No such component piece/);
    assert.throws(() => Y.removeDrawable(m, false, FEET, 0), /No such component piece/);
    assert.throws(() => Y.moveDrawable(m, false, JBIB, 0, 9), /outside/);
    assert.throws(() => Y.removeDrawable(m, true, HEAD, 0), /No such prop/);
  });
});

describe('piece options', () => {
  it('component options round-trip: audio, flags, heels, shows skin', () => {
    const m = Y.createModel('testdlc');
    Y.insertDrawable(m, false, FEET, 0, { hasSkin: false, texCount: 2 });
    const shoe = piece('feet', 0);
    const start = Y.getOptions(m, shoe);
    assert.deepEqual([start.audio, start.flags, start.hasSkin, start.heels.enabled, start.heels.value], ['none', 0, false, false, 1]);

    Y.setOptions(m, shoe, { audio: 'shoe_high_heels', flags: 1 | 64, heels: { enabled: true, value: 1.5 }, hasSkin: true });
    const o = Y.getOptions(m, shoe);
    assert.equal(o.audio, 'shoe_high_heels');
    assert.equal(o.flags, 65);
    assert.deepEqual(o.heels, { enabled: true, value: 1.5 });
    assert.equal(o.hasSkin, true);
    assert.ok(m.comps[0].drawables[0].tex.every((t) => t[0] === 1), 'every texture switches to the skin texId');

    Y.setOptions(m, shoe, { heels: { enabled: false, value: 1.5 }, hasSkin: false });
    const off = Y.getOptions(m, shoe);
    assert.equal(off.heels.enabled, false);
    assert.equal(off.hasSkin, false);
    assert.ok(m.comps[0].drawables[0].tex.every((t) => t[0] === 0));
  });

  it('flags are limited to the 21 known bits', () => {
    const m = threeTops();
    Y.setOptions(m, piece('jbib', 0), { flags: 0xffffffff });
    assert.equal(Y.getOptions(m, piece('jbib', 0)).flags, 0x1fffff);
  });

  it('prop options round-trip: render flag, flags, hair scale on hats', () => {
    const m = Y.createModel('testdlc');
    Y.insertDrawable(m, true, HEAD, 0, { texCount: 1 });
    const hat = piece('p_head', 0, 1, { prop: true });
    assert.deepEqual(Y.getOptions(m, hat).hairScale, { enabled: false, value: 0.5 }, 'default hair scale 0.5, off');
    assert.equal(Y.getOptions(m, hat).renderFlag, 'PRF_ALPHA');

    Y.setOptions(m, hat, { renderFlag: 'PRF_CUTOUT', flags: 4096, hairScale: { enabled: true, value: 0.35 } });
    const o = Y.getOptions(m, hat);
    assert.equal(o.renderFlag, 'PRF_CUTOUT');
    assert.equal(o.renderFlagValue, 2, 'ALPHA = 0, DECAL = 1, CUTOUT = 2');
    assert.equal(o.flags, 4096);
    assert.deepEqual(o.hairScale, { enabled: true, value: Math.fround(0.35) });
    assert.ok(m.props[0].raw.readFloatLE(4) < 0, 'the game stores hair scale as a negative number');

    Y.setOptions(m, hat, { hairScale: { enabled: false, value: 0.35 } });
    assert.equal(Y.getOptions(m, hat).hairScale.enabled, false);
    assert.equal(m.props[0].raw.readFloatLE(4), 0);
  });

  it('only hats get a hair scale', () => {
    const m = Y.createModel('testdlc');
    Y.insertDrawable(m, true, EYES, 0, { texCount: 1 });
    const glasses = piece('p_eyes', 0, 1, { prop: true });
    Y.setOptions(m, glasses, { hairScale: { enabled: true, value: 0.2 } });
    assert.equal('hairScale' in Y.getOptions(m, glasses), false);
    assert.equal(m.props[0].raw.readFloatLE(4), 0);
  });

  it('rejects names the lists do not know, and pieces the file does not list', () => {
    const m = threeTops();
    assert.throws(() => Y.setOptions(m, piece('jbib', 0), { audio: 'shoe_high_heels' }), /Unknown audio/);
    assert.throws(() => Y.setOptions(m, piece('jbib', 0), { flags: 'lots' }), /flags must be a number/);
    assert.throws(() => Y.setOptions(m, piece('jbib', 9), { flags: 1 }), /not listed/);
    assert.equal(Y.getOptions(m, piece('jbib', 9)), null);
    Y.insertDrawable(m, true, HEAD, 0, { texCount: 1 });
    assert.throws(() => Y.setOptions(m, piece('p_head', 0, 1, { prop: true }), { renderFlag: 'PRF_SPARKLY' }), /Unknown render flag/);
    assert.throws(() => Y.setOptions(m, piece('p_head', 0, 1, { prop: true }), { audio: 'cloth_default' }), /Unknown audio/, 'props only offer "none"');
  });

  it('creatureNeeds: one hat with hair scale covers every hat, one pair of heels covers every shoe, otherwise nothing', () => {
    const m = Y.createModel('testdlc');
    for (let i = 0; i < 3; i++) Y.insertDrawable(m, true, HEAD, i, { texCount: 1 });
    for (let i = 0; i < 2; i++) Y.insertDrawable(m, false, FEET, i, { texCount: 1 });
    assert.deepEqual(Y.creatureNeeds(m), { hats: 0, heels: 0 });
    Y.setOptions(m, piece('p_head', 1, 1, { prop: true }), { hairScale: { enabled: true, value: 0.4 } });
    assert.deepEqual(Y.creatureNeeds(m), { hats: 3, heels: 0 });
    Y.setOptions(m, piece('feet', 1), { heels: { enabled: true, value: 1 } });
    assert.deepEqual(Y.creatureNeeds(m), { hats: 3, heels: 2 });
  });
});

describe('writing and reading the file', () => {
  it('a model with pieces, options, props and anchors reads back identical', () => {
    const dir = tempDir('cs_ymt');
    const file = path.join(dir, 'rich.ymt');
    const m = richModel();
    Y.writeYmt(file, m);
    const back = Y.readYmt(file);
    assert.equal(Y.digest(Y.stripPtrs(back)), Y.digest(Y.stripPtrs(m)));
    assert.deepEqual(Y.getOptions(back, piece('feet', 0)).heels, { enabled: true, value: 1.25 });
    assert.equal(Y.getOptions(back, piece('p_head', 0, 1, { prop: true })).renderFlag, 'PRF_CUTOUT');
    assert.equal(audioOf(back, 'jbib', 1), 'cloth_upper_sweater');
  });

  it('building is deterministic, and an unchanged file is re-written byte for byte', () => {
    const m = richModel();
    const a = Y.buildYmt(m), b = Y.buildYmt(m);
    assert.ok(a.equals(b), 'same model, same bytes');
    const reread = Y.readYmt(a);
    assert.ok(Y.buildYmt(reread).equals(a), 'read -> write gives back the identical file');
    assert.ok(Y.buildYmt(Y.readYmt(Y.buildYmt(reread))).equals(a), 'and keeps doing so');
  });

  it('keeps the first version as .bak (once) and leaves no temp file behind', () => {
    const dir = tempDir('cs_ymt');
    const file = path.join(dir, 'ped.ymt');
    const v1 = threeTops();
    Y.writeYmt(file, v1, { backup: false });
    assert.equal(fs.existsSync(file + '.bak'), false, 'backup: false makes no .bak');
    const original = fs.readFileSync(file);

    const v2 = threeTops(); Y.removeDrawable(v2, false, JBIB, 0);
    const res = Y.writeYmt(file, v2);
    assert.equal(res.backup, file + '.bak');
    assert.ok(fs.readFileSync(file + '.bak').equals(original));

    const v3 = threeTops(); Y.removeDrawable(v3, false, JBIB, 1);
    Y.writeYmt(file, v3);
    assert.ok(fs.readFileSync(file + '.bak').equals(original), 'the .bak is never overwritten');
    assert.deepEqual(texCounts(Y.readYmt(file)), texCounts(v3));
    assert.equal(fs.existsSync(file + '.tmp'), false);
  });

  it('refuses files that are not a ped .ymt', () => {
    const dir = tempDir('cs_ymt');
    const file = path.join(dir, 'junk.ymt');
    fs.writeFileSync(file, Buffer.from('this is not a resource file at all'));
    assert.throws(() => Y.readYmt(file), /RSC7/);
  });
});

describe('comparing the .ymt with the texture files', () => {
  const males = () => [piece('jbib', 0, 4), piece('jbib', 1, 3), piece('jbib', 2, 1), piece('p_head', 0, 2, { prop: true })];

  it('compare lists pieces with the wrong number of textures and pieces that are missing', () => {
    const m = threeTops();                                          // textures 2, 3, 1
    Y.insertDrawable(m, true, HEAD, 0, { texCount: 1 });
    const r = Y.compare(m, [piece('jbib', 0, 4), piece('jbib', 1, 3), piece('jbib', 2, 1), piece('jbib', 3, 1), piece('p_head', 0, 1, { prop: true })]);
    assert.deepEqual(r.diffs.map((d) => [d.id, d.have, d.want]), [['male_jbib_000', 2, 4]]);
    assert.deepEqual(r.missing.map((x) => x.id), ['male_jbib_003']);
  });

  it('applyCounts fixes the counts: more textures copy the last one, fewer drop the end, totals follow', () => {
    const m = threeTops();
    Y.insertDrawable(m, true, HEAD, 0, { texCount: 1 });
    const changes = Y.applyCounts(m, males());
    assert.deepEqual(changes.map((c) => [c.id, c.from, c.to]), [['male_jbib_000', 2, 4], ['male_p_head_000', 1, 2]]);
    assert.deepEqual(texCounts(m), [4, 3, 1]);
    assert.equal(m.comps[0].raw[0], 8);
    assert.deepEqual(m.props[0].tex.map((t) => t[8]), [0, 1]);
    assert.deepEqual(m.anchors[0].bytes, [2]);
    assert.deepEqual(Y.compare(m, males()).diffs, []);

    Y.applyCounts(m, [piece('jbib', 1, 1)]);
    assert.deepEqual(texCounts(m), [4, 1, 1]);
  });

  it('applyCounts can be limited to one piece', () => {
    const m = threeTops();
    const changes = Y.applyCounts(m, [piece('jbib', 0, 5), piece('jbib', 1, 5)], 'male_jbib_001');
    assert.equal(changes.length, 1);
    assert.deepEqual(texCounts(m), [2, 5, 1]);
  });

  it('ensureListed adds files the .ymt does not know yet, in order, but not across a gap', () => {
    const m = Y.createModel('testdlc');
    Y.insertDrawable(m, false, JBIB, 0, { texCount: 1 });
    const items = [piece('jbib', 0, 1), piece('jbib', 1, 2, { race: 'u' }), piece('jbib', 2, 3, { race: 'r' }), piece('jbib', 4, 1)];
    const added = Y.ensureListed(m, items);
    assert.deepEqual(added.map((a) => a.id), ['male_jbib_001', 'male_jbib_002']);
    assert.deepEqual(texCounts(m), [1, 2, 3]);
    assert.equal(Y.getOptions(m, piece('jbib', 2)).hasSkin, true, 'a race-specific (_r) model is a "shows skin" piece');
    assert.equal(Y.getOptions(m, piece('jbib', 1)).hasSkin, false);
    assert.deepEqual(Y.compare(m, items).missing.map((x) => x.id), ['male_jbib_004'], 'the gap stays reported');
  });
});
