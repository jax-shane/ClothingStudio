'use strict';
// Covers src/lib/pack.js (finding pieces and textures in a resource folder) and the naming conventions in
// src/lib/packops.js (how the model / texture file names of a piece are built, renumbered and guessed).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanPack, parseName } = require('../src/lib/pack');
const P = require('../src/lib/packops');
const { tempDir, cleanup, makePack } = require('./helpers');

after(cleanup);

/** write empty files (and a .meta with the dlc name) to build a pack by hand */
function handmade(files, dlc = 'gsp') {
  const root = path.join(tempDir('cs_scan'), 'my_pack');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, `mp_m_freemode_01_${dlc}.meta`), `<ShopPedApparel><dlcName>${dlc}</dlcName></ShopPedApparel>`);
  for (const f of files) { const p = path.join(root, 'stream', f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); }
  return root;
}

describe('file names', () => {
  it('parseName reads gender, dlc, slot, number, texture letter and skin from a file name', () => {
    assert.deepEqual(parseName('mp_m_freemode_01_gsp^jbib_000_u.ydd'), { type: 'ydd', gender: 'male', dlc: 'gsp', prop: false, comp: 'jbib', drawable: '000', race: 'u' });
    assert.deepEqual(parseName('mp_f_freemode_01_gsp^lowr_012_r.ydd'), { type: 'ydd', gender: 'female', dlc: 'gsp', prop: false, comp: 'lowr', drawable: '012', race: 'r' });
    assert.deepEqual(parseName('mp_m_freemode_01_gsp^jbib_diff_001_b_uni.ytd'), { type: 'ytd', gender: 'male', dlc: 'gsp', prop: false, comp: 'jbib', drawable: '001', letter: 'b', race: 'uni' });
    assert.deepEqual(parseName('mp_m_freemode_01_p_gsp^p_head_002.ydd'), { type: 'ydd', gender: 'male', dlc: 'gsp', prop: true, comp: 'p_head', drawable: '002' });
    assert.deepEqual(parseName('mp_m_freemode_01_p_gsp^p_head_diff_002_c.ytd'), { type: 'ytd', gender: 'male', dlc: 'gsp', prop: true, comp: 'p_head', drawable: '002', letter: 'c' });
    assert.equal(parseName('mp_m_freemode_01_p_gsp^p_ph_l_hand_000.ydd').comp, 'p_ph_l_hand', 'multi-word prop names');
  });

  it('files that are not drawables or textures are classed "other" or ignored', () => {
    assert.equal(parseName('mp_m_freemode_01_gsp.ymt'), null, 'no ^ in the name');
    assert.equal(parseName('fxmanifest.lua'), null);
    assert.equal(parseName('mp_m_freemode_01_gsp^jbib_000_u.yld').type, 'other', 'cloth physics belongs to a piece but is not a piece');
    assert.equal(parseName('mp_m_freemode_01_gsp^zzzz_000_u.ydd').type, 'other', 'not a real component slot');
  });

  it('yddFile / ytdFile build the names FiveM expects', () => {
    assert.equal(P.yddFile('male', false, 'gsp', 'jbib', 0, false), 'mp_m_freemode_01_gsp^jbib_000_u.ydd');
    assert.equal(P.yddFile('female', false, 'gsp', 'lowr', 12, true), 'mp_f_freemode_01_gsp^lowr_012_r.ydd');
    assert.equal(P.yddFile('male', true, 'gsp', 'p_head', 3, false), 'mp_m_freemode_01_p_gsp^p_head_003.ydd');
    assert.equal(P.ytdFile('male', false, 'gsp', 'jbib', 1, 'b', false), 'mp_m_freemode_01_gsp^jbib_diff_001_b_uni.ytd');
    assert.equal(P.ytdFile('female', false, 'gsp', 'feet', 4, 'a', true), 'mp_f_freemode_01_gsp^feet_diff_004_a_whi.ytd');
    assert.equal(P.ytdFile('male', true, 'gsp', 'p_head', 3, 'c', false), 'mp_m_freemode_01_p_gsp^p_head_diff_003_c.ytd');
  });

  it('names built by packops are read back by scanPack (the two always agree)', () => {
    for (const [g, prop, comp, skin] of [['male', false, 'jbib', false], ['female', false, 'feet', true], ['male', true, 'p_eyes', false]]) {
      const ydd = parseName(P.yddFile(g, prop, 'gsp', comp, 7, skin));
      const tex = parseName(P.ytdFile(g, prop, 'gsp', comp, 7, 'b', skin));
      assert.deepEqual([ydd.type, ydd.gender, ydd.comp, ydd.drawable, ydd.prop], ['ydd', g, comp, '007', prop]);
      assert.deepEqual([tex.type, tex.gender, tex.comp, tex.drawable, tex.letter], ['ytd', g, comp, '007', 'b']);
    }
  });

  it('renumberName changes only the piece number, in models and textures alike', () => {
    assert.equal(P.renumberName('mp_m_freemode_01_gsp^jbib_002_u.ydd', 'jbib', 1), 'mp_m_freemode_01_gsp^jbib_001_u.ydd');
    assert.equal(P.renumberName('mp_m_freemode_01_gsp^jbib_diff_002_b_uni.ytd', 'jbib', 0), 'mp_m_freemode_01_gsp^jbib_diff_000_b_uni.ytd');
    assert.equal(P.renumberName('mp_m_freemode_01_p_gsp^p_head_diff_010_a.ytd.bak', 'p_head', 9), 'mp_m_freemode_01_p_gsp^p_head_diff_009_a.ytd.bak');
  });

  it('guessYdd works out what a model is from its name, and says "unknown" when the name does not tell', () => {
    const g = (n) => { const r = P.guessYdd(n); return [r.gender, r.prop, r.comp, r.hasSkin]; };
    assert.deepEqual(g('jbib_003_u.ydd'), [null, false, 'jbib', false]);
    assert.deepEqual(g('mp_f_freemode_01_gsp^lowr_001_r.ydd'), ['female', false, 'lowr', true]);
    assert.deepEqual(g('mp_m_freemode_01_p_gsp^p_head_002.ydd'), ['male', true, 'p_head', false]);
    assert.deepEqual(g('jbib_003_u_1.ydd'), [null, false, 'jbib', false], 'first-person alternate (_1)');
    assert.deepEqual(g('chest_badge.ydd'), [null, null, null, null], 'the app asks the user what this is');
    assert.deepEqual(g('abcd_001_u.ydd'), [null, null, null, null], 'a 4-letter name that is no real slot');
  });
});

describe('scanPack', () => {
  const FILES = [
    '[male]/jbib/mp_m_freemode_01_gsp^jbib_001_u.ydd',
    '[male]/jbib/mp_m_freemode_01_gsp^jbib_diff_001_b_uni.ytd',          // b is created before a on purpose
    '[male]/jbib/mp_m_freemode_01_gsp^jbib_diff_001_a_uni.ytd',
    '[male]/jbib/mp_m_freemode_01_gsp^jbib_000_u.ydd',
    '[male]/jbib/mp_m_freemode_01_gsp^jbib_diff_000_a_uni.ytd',
    '[male]/lowr/mp_m_freemode_01_gsp^lowr_000_r.ydd',
    '[male]/lowr/mp_m_freemode_01_gsp^lowr_diff_000_a_whi.ytd',
    '[male]/p_head/mp_m_freemode_01_p_gsp^p_head_000.ydd',
    '[male]/p_head/mp_m_freemode_01_p_gsp^p_head_diff_000_a.ytd',
    '[female]/jbib/mp_f_freemode_01_gsp^jbib_000_u.ydd',
    '[female]/jbib/mp_f_freemode_01_gsp^jbib_diff_000_a_uni.ytd',
    '[male]/jbib/mp_m_freemode_01_gsp^jbib_diff_009_a_uni.ytd',          // a texture with no model: not a piece
    '[male]/jbib/notes.txt',
  ];

  it('groups files into pieces with sorted texture variants, names and skin', () => {
    const pack = scanPack(handmade(FILES));
    assert.equal(pack.dlcName, 'gsp');
    assert.equal(pack.name, 'my_pack');
    assert.deepEqual(pack.items.map((i) => i.id), [
      'female_jbib_000', 'male_p_head_000', 'male_lowr_000', 'male_jbib_000', 'male_jbib_001',
    ], 'sorted by gender, then group name, then number');
    const by = Object.fromEntries(pack.items.map((i) => [i.id, i]));
    assert.deepEqual(by.male_jbib_001.variants.map((v) => v.letter), ['a', 'b'], 'letters come out in order');
    assert.equal(by.male_jbib_001.label, 'Top 001');
    assert.equal(by.male_jbib_001.group, 'Tops');
    assert.equal(by.male_jbib_001.slot, 11);
    assert.equal(by.male_jbib_001.race, 'u');
    assert.equal(by.male_lowr_000.race, 'r', 'a _r model is race specific = shows skin');
    assert.equal(by.male_lowr_000.variants[0].race, 'whi');
    assert.deepEqual([by.male_p_head_000.prop, by.male_p_head_000.slot, by.male_p_head_000.race, by.male_p_head_000.group], [true, null, null, 'Hats']);
    assert.equal(by.male_p_head_000.label, 'Hat 000');
    assert.ok(!pack.items.some((i) => i.drawable === '009'), 'a texture without a model is not shown');
  });

  it('a model without textures is still listed (with no variants)', () => {
    const pack = scanPack(handmade(['[male]/jbib/mp_m_freemode_01_gsp^jbib_000_u.ydd']));
    assert.equal(pack.items.length, 1);
    assert.deepEqual(pack.items[0].variants, []);
  });

  it('a brand new pack (stream folder + .meta, no pieces yet) opens as an empty pack', () => {
    const root = makePack('fresh_pack');
    const pack = scanPack(root);
    assert.equal(pack.dlcName, 'fresh_pack');
    assert.deepEqual(pack.items, []);
  });

  it('refuses folders that are not clothing packs', () => {
    const empty = tempDir('cs_scan');
    assert.throws(() => scanPack(empty), /no \.ydd \/ \.ytd files found/);
    assert.throws(() => scanPack(path.join(empty, 'missing')), /not a folder/);
  });
});
