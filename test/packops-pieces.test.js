'use strict';
// Covers the piece operations in src/lib/packops.js on a pack built from scratch in a temp folder:
// making a new pack, adding pieces and textures, moving (swapping) pieces, deleting with renumbering, and the
// per-piece options (audio / flags / render flag / hair scale / heels / "shows skin"). Every operation must keep the
// .ydd files, the .ytd files and the .ymt in step - that is what these tests check - and must leave nothing behind
// when it fails half way.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/lib/packops');
const Y = require('../src/lib/ymt');
const C = require('../src/lib/creature');
const { scanPack } = require('../src/lib/pack');
const H = require('./helpers');
const { tex, add, item, names, tree, snapshot, ymtOf, texCounts, makeBin, makePack, markerOf, colourOf, sameColour, RED, GREEN, BLUE, YELLOW } = H;

after(H.cleanup);

const JBIB = Y.COMP_SLOT.jbib, FEET = Y.COMP_SLOT.feet;
const topsDir = (root) => path.join(root, 'stream', '[male]', 'jbib');
const ydd = (root, n, skin = false) => path.join(topsDir(root), P.yddFile('male', false, 'test_pack', 'jbib', n, skin));
const ytdF = (root, n, letter, skin = false) => path.join(topsDir(root), P.ytdFile('male', false, 'test_pack', 'jbib', n, letter, skin));
const creaturePath = (root, g = 'm') => path.join(root, 'stream', `mp_creaturemetadata_${g}_test_pack.ymt`);
/** how many ymt entries disagree with the files in the pack (0 = the ".ymt âœ“" chip) */
function ymtProblems(root, gender = 'male') {
  const r = Y.compare(ymtOf(root, gender), scanPack(root).items.filter((i) => i.gender === gender));
  return r.diffs.length + r.missing.length;
}

describe('a new pack', () => {
  it('has a manifest, a .meta and an empty .ymt per gender, and no creature metadata', () => {
    const root = makePack('my_clothes');
    assert.deepEqual(tree(root), [
      'fxmanifest.lua', 'mp_f_freemode_01_my_clothes.meta', 'mp_m_freemode_01_my_clothes.meta',
      'stream/mp_f_freemode_01_my_clothes.ymt', 'stream/mp_m_freemode_01_my_clothes.ymt',
    ]);
    const lua = fs.readFileSync(path.join(root, 'fxmanifest.lua'), 'utf8');
    assert.match(lua, /fx_version 'cerulean'/);
    assert.match(lua, /data_file 'SHOP_PED_APPAREL_META_FILE' 'mp_m_freemode_01_my_clothes\.meta'/);
    assert.match(lua, /data_file 'SHOP_PED_APPAREL_META_FILE' 'mp_f_freemode_01_my_clothes\.meta'/);
    const meta = fs.readFileSync(path.join(root, 'mp_f_freemode_01_my_clothes.meta'), 'utf8');
    assert.match(meta, /<dlcName>my_clothes<\/dlcName>/);
    assert.match(meta, /<creatureMetaData>mp_creaturemetadata_f_my_clothes<\/creatureMetaData>/);
    assert.equal(Y.readYmt(P.findYmt(root, 'my_clothes', 'male')).name, 'my_clothes');
  });

  it('only accepts safe resource names and never writes into a folder that has files in it', () => {
    const parent = H.tempDir('cs_new');
    for (const bad of ['', 'has space', '../up', 'a/b', 'x'.repeat(41), 'Ã¼mlaut']) assert.throws(() => P.createPack(parent, bad), /letters, digits and underscores/, JSON.stringify(bad));
    assert.equal(P.validName('my_clothes_2'), true);
    P.createPack(parent, 'taken');
    assert.throws(() => P.createPack(parent, 'taken'), /already exists and is not empty/);
  });
});

describe('adding pieces', () => {
  it('a top with two textures: right file names, right folder, listed in the .ymt', () => {
    const root = makePack();
    const res = add(root, { marker: 'top', textures: [tex(RED), tex(GREEN)] });
    assert.equal(res.id, 'male_jbib_000');
    assert.equal(res.number, 0);
    assert.equal(res.ymt, 'mp_m_freemode_01_test_pack.ymt');
    assert.deepEqual(names(res.files), [
      'mp_m_freemode_01_test_pack^jbib_000_u.ydd',
      'mp_m_freemode_01_test_pack^jbib_diff_000_a_uni.ytd',
      'mp_m_freemode_01_test_pack^jbib_diff_000_b_uni.ytd',
    ]);
    assert.ok(res.files.every((f) => path.dirname(f) === topsDir(root)), 'stream/[male]/jbib');
    assert.equal(markerOf(ydd(root, 0)), 'top', 'the model was copied as it is');
    assert.ok(sameColour(colourOf(ytdF(root, 0, 'a')), RED) && sameColour(colourOf(ytdF(root, 0, 'b')), GREEN));
    assert.deepEqual(texCounts(root, JBIB), [2]);
    assert.equal(ymtProblems(root), 0);
  });

  it('new pieces get the next free number; a model that shows skin is named _r / _whi', () => {
    const root = makePack();
    add(root, { marker: 'a' });
    const second = add(root, { marker: 'b', hasSkin: true, textures: [tex(BLUE)] });
    assert.equal(second.id, 'male_jbib_001');
    assert.deepEqual(names(second.files), ['mp_m_freemode_01_test_pack^jbib_001_r.ydd', 'mp_m_freemode_01_test_pack^jbib_diff_001_a_whi.ytd']);
    assert.equal(Y.getOptions(ymtOf(root), { comp: 'jbib', prop: false, drawable: '001' }).hasSkin, true);
    assert.equal(ymtProblems(root), 0);
  });

  it('props and the female side go to their own folders and their own .ymt', () => {
    const root = makePack();
    const hat = add(root, { comp: 'p_head', prop: true, textures: [tex(RED), tex(GREEN), tex(BLUE)] });
    assert.deepEqual(names(hat.files).slice(0, 2), ['mp_m_freemode_01_p_test_pack^p_head_000.ydd', 'mp_m_freemode_01_p_test_pack^p_head_diff_000_a.ytd']);
    assert.ok(hat.files.every((f) => path.dirname(f) === path.join(root, 'stream', '[male]', 'p_head')));
    const woman = add(root, { gender: 'female' });
    assert.equal(woman.ymt, 'mp_f_freemode_01_test_pack.ymt');
    assert.ok(woman.files[0].includes(path.join('stream', '[female]', 'jbib')));
    assert.equal(ymtOf(root).props.length, 1);
    assert.equal(ymtOf(root).props[0].tex.length, 3);
    assert.equal(ymtOf(root, 'female').comps.length, 1);
    assert.equal(ymtProblems(root, 'male'), 0);
    assert.equal(ymtProblems(root, 'female'), 0);
  });

  it('cloth physics (.yld) next to the source model comes along', () => {
    const root = makePack();
    const src = H.fakeYdd('cloth');
    fs.writeFileSync(src.replace(/\.ydd$/, '.yld'), 'FAKE-YLD');
    const res = P.addPiece(root, { gender: 'male', prop: false, comp: 'jbib', hasSkin: false, ydd: src, textures: [{ kind: 'blank' }] });
    assert.ok(names(res.files).includes('mp_m_freemode_01_test_pack^jbib_000_u.yld'));
  });

  it('textures can be a blank grey one, an image (png pixels) or a ready .ytd', () => {
    const root = makePack();
    const px = H.solidRgba(0, 255, 0);
    const res = add(root, { textures: [{ kind: 'blank' }, { kind: 'png', rgba: px, width: H.SIZE, height: H.SIZE }, tex(YELLOW)] });
    assert.equal(res.files.length, 4);
    const grey = colourOf(ytdF(root, 0, 'a'));
    assert.ok(sameColour(grey, [128, 128, 128]), 'blank = neutral grey ' + grey);
    assert.ok(sameColour(colourOf(ytdF(root, 0, 'b')), GREEN));
    assert.ok(sameColour(colourOf(ytdF(root, 0, 'c')), YELLOW));
  });

  it('refuses bad requests before touching anything', () => {
    const root = makePack();
    const before = snapshot(root);
    const base = { gender: 'male', prop: false, comp: 'jbib', hasSkin: false, ydd: H.fakeYdd('x'), textures: [tex(RED)] };
    assert.throws(() => P.addPiece(root, { ...base, textures: [] }), /at least one texture/);
    assert.throws(() => P.addPiece(root, { ...base, gender: 'other' }), /male or female/);
    assert.throws(() => P.addPiece(root, { ...base, comp: 'zzzz' }), /what kind of piece/);
    assert.throws(() => P.addPiece(root, { ...base, textures: Array(27).fill(tex(RED)) }), /at most 26/);
    assert.deepEqual(snapshot(root), before);
  });

  it('an image of the wrong size, or a texture file that is not a .ytd, undoes the whole piece', () => {
    const root = makePack();
    add(root, { marker: 'keep' });
    const before = snapshot(root);
    const junk = path.join(H.tempDir('cs_junk'), 'junk.ytd');
    fs.writeFileSync(junk, 'not a texture dictionary');
    assert.throws(() => add(root, { textures: [tex(RED), { kind: 'png', rgba: Buffer.alloc(64 * 64 * 4), width: 64, height: 64 }] }), /must be 1024.1024 pixels/);
    assert.deepEqual(snapshot(root), before, 'the model and the first texture that were already copied are gone again, .ymt unchanged');
    assert.throws(() => add(root, { textures: [tex(GREEN), { kind: 'ytd', path: junk }] }), /RSC7/);
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.existsSync(path.join(root, '.cs_journal.json')), false, 'no journal left behind');
  });
});

describe('adding textures to a piece', () => {
  it('each new texture takes the next letter and the .ymt count follows', () => {
    const root = makePack();
    add(root, { textures: [tex(RED), tex(GREEN)] });
    const res = P.addTextures(root, 'male_jbib_000', [tex(BLUE), tex(YELLOW)]);
    assert.deepEqual(names(res.files), ['mp_m_freemode_01_test_pack^jbib_diff_000_c_uni.ytd', 'mp_m_freemode_01_test_pack^jbib_diff_000_d_uni.ytd']);
    assert.ok(sameColour(colourOf(ytdF(root, 0, 'd')), YELLOW));
    assert.deepEqual(texCounts(root, JBIB), [4]);
    assert.equal(ymtProblems(root), 0);
  });

  it('a gap in the letters is not refilled: the next letter comes after the highest one', () => {
    const root = makePack();
    add(root, { textures: [tex(RED), tex(GREEN), tex(BLUE)] });
    fs.unlinkSync(ytdF(root, 0, 'b'));
    const res = P.addTextures(root, 'male_jbib_000', [tex(YELLOW)]);
    assert.deepEqual(names(res.files), ['mp_m_freemode_01_test_pack^jbib_diff_000_d_uni.ytd']);
  });

  it('stops at 26 textures (a-z)', () => {
    const root = makePack();
    add(root, { textures: [tex(RED)] });
    P.addTextures(root, 'male_jbib_000', Array(25).fill(tex(GREEN)));
    assert.equal(item(root, 'male_jbib_000').variants.length, 26);
    assert.throws(() => P.addTextures(root, 'male_jbib_000', [tex(BLUE)]), /at most 26/);
    assert.equal(item(root, 'male_jbib_000').variants.length, 26);
  });

  it('a bad texture file undoes the textures that were already written', () => {
    const root = makePack();
    add(root, { textures: [tex(RED)] });
    const junk = path.join(H.tempDir('cs_junk'), 'junk.ytd');
    fs.writeFileSync(junk, 'nope');
    const before = snapshot(root);
    assert.throws(() => P.addTextures(root, 'male_jbib_000', [tex(GREEN), { kind: 'ytd', path: junk }]), /RSC7/);
    assert.deepEqual(snapshot(root), before);
  });
});

describe('moving pieces', () => {
  /** three tops: A has one red texture, B has green + blue, C has one yellow. B has its own audio. */
  function threeTops() {
    const root = makePack();
    add(root, { marker: 'A', textures: [tex(RED)] });
    add(root, { marker: 'B', textures: [tex(GREEN), tex(BLUE)] });
    add(root, { marker: 'C', textures: [tex(YELLOW)] });
    P.setPieceOptions(root, 'male_jbib_001', { audio: 'cloth_upper_sweater' });
    return root;
  }

  it('moving 002 to 000 renames models AND textures together, and the .ymt follows', () => {
    const root = threeTops();
    fs.writeFileSync(ytdF(root, 0, 'a') + '.bak', 'backup of A');                // a .bak travels with its texture
    const res = P.movePiece(root, 'male_jbib_002', 0);
    assert.equal(res.ymt, 'mp_m_freemode_01_test_pack.ymt');

    assert.equal(markerOf(ydd(root, 0)), 'C');
    assert.equal(markerOf(ydd(root, 1)), 'A');
    assert.equal(markerOf(ydd(root, 2)), 'B');
    assert.ok(sameColour(colourOf(ytdF(root, 0, 'a')), YELLOW), 'C keeps its texture');
    assert.ok(sameColour(colourOf(ytdF(root, 1, 'a')), RED), 'A keeps its texture');
    assert.ok(sameColour(colourOf(ytdF(root, 2, 'a')), GREEN) && sameColour(colourOf(ytdF(root, 2, 'b')), BLUE), 'B keeps both');
    assert.equal(fs.readFileSync(ytdF(root, 1, 'a') + '.bak', 'utf8'), 'backup of A');
    assert.deepEqual(texCounts(root, JBIB), [1, 1, 2]);
    assert.equal(P.getPieceOptions(root, 'male_jbib_002').options.audio, 'cloth_upper_sweater', 'B took its audio with it');
    assert.equal(P.getPieceOptions(root, 'male_jbib_001').options.audio, 'none');
    assert.equal(ymtProblems(root), 0);
    assert.deepEqual(tree(root).filter((f) => /cs_mv|cs_journal/.test(f)), [], 'no temporary names or journal left');
  });

  it('moving 002 to 001 swaps the two', () => {
    const root = threeTops();
    P.movePiece(root, 'male_jbib_002', 1);
    assert.deepEqual([0, 1, 2].map((n) => markerOf(ydd(root, n))), ['A', 'C', 'B']);
    assert.deepEqual(texCounts(root, JBIB), [1, 1, 2]);
    assert.equal(ymtProblems(root), 0);
  });

  it('moving a piece to where it already is changes nothing', () => {
    const root = threeTops();
    const before = snapshot(root);
    assert.deepEqual(P.movePiece(root, 'male_jbib_001', 1).renames, []);
    assert.deepEqual(snapshot(root), before);
  });

  it('refuses a position that does not exist, and numbering gaps', () => {
    const root = threeTops();
    assert.throws(() => P.movePiece(root, 'male_jbib_000', 3), /no position 003/);
    assert.throws(() => P.movePiece(root, 'male_jbib_000', -1), /no position/);
    assert.throws(() => P.movePiece(root, 'male_jbib_009', 0), /not in the pack any more/);
    for (const f of tree(root).filter((x) => x.includes('jbib_001') || x.includes('jbib_diff_001'))) fs.unlinkSync(path.join(root, f));
    assert.throws(() => P.movePiece(root, 'male_jbib_000', 1), /has a gap/);
  });

  it('props move too, in their own numbering', () => {
    const root = makePack();
    add(root, { comp: 'p_head', prop: true, marker: 'h0', textures: [tex(RED)] });
    add(root, { comp: 'p_head', prop: true, marker: 'h1', textures: [tex(GREEN), tex(BLUE)] });
    P.movePiece(root, 'male_p_head_001', 0);
    const hat = (n) => path.join(root, 'stream', '[male]', 'p_head', P.yddFile('male', true, 'test_pack', 'p_head', n, false));
    assert.equal(markerOf(hat(0)), 'h1');
    assert.equal(markerOf(hat(1)), 'h0');
    assert.deepEqual(item(root, 'male_p_head_000').variants.map((v) => v.letter), ['a', 'b']);
    assert.equal(ymtProblems(root), 0);
  });

  it('warns about files that list pieces by number and that the app does not rewrite', () => {
    const root = threeTops();
    fs.writeFileSync(path.join(root, 'first_person_alternates_test_pack.meta'), '<x/>');
    const res = P.movePiece(root, 'male_jbib_002', 0);
    assert.deepEqual(res.warnings, ['first_person_alternates_test_pack.meta']);
  });

  it('if a rename fails half way, everything is put back as it was', () => {
    const root = threeTops();
    const before = snapshot(root);
    // a leftover temp name in the way of the third piece's model: pieces 0 and 1 are parked first, then this one fails
    fs.writeFileSync(ydd(root, 2) + '.cs_mv', 'in the way');
    const withStray = snapshot(root);
    assert.notDeepEqual(withStray, before);
    assert.throws(() => P.movePiece(root, 'male_jbib_002', 0), /already exists/);
    assert.deepEqual(snapshot(root), withStray, 'all files back under their old names, .ymt untouched');
  });
});

describe('deleting pieces', () => {
  function threeTops() {
    const root = makePack();
    add(root, { marker: 'A', textures: [tex(RED)] });
    add(root, { marker: 'B', textures: [tex(GREEN), tex(BLUE)] });
    add(root, { marker: 'C', textures: [tex(YELLOW)] });
    return root;
  }

  it('deleting 001 sends its files to the bin under their real names and renumbers 002 to 001', async () => {
    const root = threeTops();
    fs.writeFileSync(ytdF(root, 1, 'a') + '.bak', 'backup');
    const bin = makeBin();
    const res = await P.deletePiece(root, 'male_jbib_001', { trash: bin.trash });

    assert.deepEqual(bin.trashed.sort(), [
      'mp_m_freemode_01_test_pack^jbib_001_u.ydd',
      'mp_m_freemode_01_test_pack^jbib_diff_001_a_uni.ytd',
      'mp_m_freemode_01_test_pack^jbib_diff_001_a_uni.ytd.bak',
      'mp_m_freemode_01_test_pack^jbib_diff_001_b_uni.ytd',
    ]);
    assert.equal(res.deleted.length, 4);
    assert.deepEqual(res.renames.map((r) => [path.basename(r.from), path.basename(r.to)]).sort(), [
      ['mp_m_freemode_01_test_pack^jbib_002_u.ydd', 'mp_m_freemode_01_test_pack^jbib_001_u.ydd'],
      ['mp_m_freemode_01_test_pack^jbib_diff_002_a_uni.ytd', 'mp_m_freemode_01_test_pack^jbib_diff_001_a_uni.ytd'],
    ].sort());
    assert.equal(markerOf(ydd(root, 0)), 'A');
    assert.equal(markerOf(ydd(root, 1)), 'C', 'C is the new 001');
    assert.ok(sameColour(colourOf(ytdF(root, 1, 'a')), YELLOW));
    assert.equal(fs.existsSync(ydd(root, 2)), false);
    assert.deepEqual(scanPack(root).items.map((i) => i.id), ['male_jbib_000', 'male_jbib_001']);
    assert.deepEqual(texCounts(root, JBIB), [1, 1]);
    assert.equal(ymtProblems(root), 0);
    assert.deepEqual(tree(root).filter((f) => /cs_journal|cs_mv/.test(f)), []);
  });

  it('deleting the first piece shifts all the others down; deleting the last one shifts nothing', async () => {
    const root = threeTops();
    await P.deletePiece(root, 'male_jbib_000', { trash: makeBin().trash });
    assert.deepEqual([0, 1].map((n) => markerOf(ydd(root, n))), ['B', 'C']);
    assert.ok(sameColour(colourOf(ytdF(root, 0, 'b')), BLUE));
    const res = await P.deletePiece(root, 'male_jbib_001', { trash: makeBin().trash });
    assert.deepEqual(res.renames, []);
    assert.deepEqual(texCounts(root, JBIB), [2]);
  });

  it('without a trash function the files are removed for good (the app always passes the Recycle Bin)', async () => {
    const root = threeTops();
    const res = await P.deletePiece(root, 'male_jbib_002');
    assert.ok(res.deleted.every((f) => !fs.existsSync(f)));
  });

  it('removing the last piece of a slot also removes the slot from the .ymt', async () => {
    const root = makePack();
    add(root, { textures: [tex(RED)] });
    await P.deletePiece(root, 'male_jbib_000', { trash: makeBin().trash });
    assert.equal(ymtOf(root).comps.length, 0);
    assert.deepEqual(scanPack(root).items, []);
  });

  it('a trash failure part way puts every file back and cleans up its temporary copies', async () => {
    const root = threeTops();
    const before = snapshot(root);
    const tempsBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cs_del_'));
    let calls = 0;
    const flaky = async (f) => { if (++calls === 2) throw new Error('the Recycle Bin said no'); fs.unlinkSync(f); };
    await assert.rejects(P.deletePiece(root, 'male_jbib_001', { trash: flaky }), /Recycle Bin said no/);
    assert.deepEqual(snapshot(root), before, 'the piece is complete again, the .ymt untouched');
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cs_del_')), tempsBefore);
  });

  it('refuses to touch a pack whose .ymt does not list the piece', async () => {
    const root = threeTops();
    Y.writeYmt(P.findYmt(root, 'test_pack', 'male'), Y.createModel('test_pack'), { backup: false });   // forget everything
    const before = snapshot(root);
    await assert.rejects(P.deletePiece(root, 'male_jbib_001', { trash: makeBin().trash }), /does not list .* cannot be changed safely/);
    assert.deepEqual(snapshot(root), before);
  });

  it('works on a pack that has no .ymt at all (only the files change)', async () => {
    const root = threeTops();
    fs.unlinkSync(P.findYmt(root, 'test_pack', 'male'));
    const res = await P.deletePiece(root, 'male_jbib_000', { trash: makeBin().trash });
    assert.equal(res.ymt, null);
    assert.deepEqual([0, 1].map((n) => markerOf(ydd(root, n))), ['B', 'C']);
  });

  it('refuses when the numbering has a gap (the .ymt stores pieces by position)', async () => {
    const root = threeTops();
    for (const f of tree(root).filter((x) => /jbib_(diff_)?001/.test(x))) fs.unlinkSync(path.join(root, f));
    await assert.rejects(P.deletePiece(root, 'male_jbib_000', { trash: makeBin().trash }), /has a gap/);
  });
});

describe('piece options', () => {
  it('getPieceOptions returns the current values and the lists the dialog offers', () => {
    const root = makePack();
    add(root, { comp: 'p_head', prop: true });
    add(root);
    const hat = P.getPieceOptions(root, 'male_p_head_000');
    assert.equal(hat.prop, true);
    assert.deepEqual(hat.audioList, ['none']);
    assert.deepEqual(hat.renderFlags, ['PRF_ALPHA', 'PRF_DECAL', 'PRF_CUTOUT']);
    assert.deepEqual(hat.options.hairScale, { enabled: false, value: 0.5 });
    const top = P.getPieceOptions(root, 'male_jbib_000');
    assert.ok(top.audioList.includes('cloth_upper_sweater'));
    assert.equal(top.flags.length, 21);
    assert.equal(top.options.hasSkin, false);
  });

  it('audio and flags are saved into the .ymt (and nothing else is renamed)', () => {
    const root = makePack();
    add(root);
    const before = tree(root).filter((f) => !f.endsWith('.bak'));
    const res = P.setPieceOptions(root, 'male_jbib_000', { audio: 'cloth_upper_jacket_leather', flags: 2 | 512 });
    assert.deepEqual(res.renames, []);
    assert.deepEqual(tree(root).filter((f) => !f.endsWith('.bak')), before);
    const o = P.getPieceOptions(root, 'male_jbib_000').options;
    assert.deepEqual([o.audio, o.flags], ['cloth_upper_jacket_leather', 514]);
    assert.equal(fs.existsSync(P.findYmt(root, 'test_pack', 'male') + '.bak'), true, 'the original .ymt was kept once');
  });

  it('a bad value is refused and nothing is written', () => {
    const root = makePack();
    add(root);
    const before = snapshot(root);
    assert.throws(() => P.setPieceOptions(root, 'male_jbib_000', { audio: 'not_a_sound' }), /Unknown audio/);
    assert.deepEqual(snapshot(root), before);
  });

  it('"Shows skin" renames the model and its textures (_u/_uni <-> _r/_whi) and flips the .ymt flag', () => {
    const root = makePack();
    add(root, { textures: [tex(RED), tex(GREEN)] });
    fs.writeFileSync(ytdF(root, 0, 'a') + '.bak', 'bak');
    let res = P.setPieceOptions(root, 'male_jbib_000', { hasSkin: true });
    assert.deepEqual(res.renames.map((r) => path.basename(r.to)).sort(), [
      'mp_m_freemode_01_test_pack^jbib_000_r.ydd',
      'mp_m_freemode_01_test_pack^jbib_diff_000_a_whi.ytd',
      'mp_m_freemode_01_test_pack^jbib_diff_000_a_whi.ytd.bak',
      'mp_m_freemode_01_test_pack^jbib_diff_000_b_whi.ytd',
    ]);
    const it = item(root, 'male_jbib_000');
    assert.deepEqual([it.race, it.variants.map((v) => v.race)], ['r', ['whi', 'whi']]);
    assert.ok(sameColour(colourOf(ytdF(root, 0, 'b', true)), GREEN), 'content unchanged by the rename');
    assert.equal(P.getPieceOptions(root, 'male_jbib_000').options.hasSkin, true);
    assert.equal(ymtProblems(root), 0);

    assert.deepEqual(P.setPieceOptions(root, 'male_jbib_000', { hasSkin: true }).renames, [], 'already on: nothing to rename');
    res = P.setPieceOptions(root, 'male_jbib_000', { hasSkin: false });
    assert.equal(res.renames.length, 4);
    assert.ok(fs.existsSync(ydd(root, 0, false)));
    assert.equal(P.getPieceOptions(root, 'male_jbib_000').options.hasSkin, false);
  });

  it('props have no "shows skin" - the setting is ignored', () => {
    const root = makePack();
    add(root, { comp: 'p_head', prop: true });
    const before = tree(root).filter((f) => !f.endsWith('.bak'));
    assert.deepEqual(P.setPieceOptions(root, 'male_p_head_000', { hasSkin: true }).renames, []);
    assert.deepEqual(tree(root).filter((f) => !f.endsWith('.bak')), before);
  });

  it('hair scale on one hat creates creature metadata for ALL hats; new hats join it; switching it off removes the file', () => {
    const root = makePack();
    add(root, { comp: 'p_head', prop: true });
    add(root, { comp: 'p_head', prop: true });
    assert.equal(fs.existsSync(creaturePath(root)), false, 'no creature metadata until something needs it');

    P.setPieceOptions(root, 'male_p_head_001', { hairScale: { enabled: true, value: 0.35 } });
    const props = () => C.readCreature(creaturePath(root)).children.find((c) => c.name === 'pedPropExpressions').children;
    assert.equal(props().length, 3, 'the dummy first entry + both hats');
    assert.deepEqual(props().map((p) => C.field(p, 'pedPropVarIndex')), [0xffffffff, 0, 1]);

    add(root, { comp: 'p_head', prop: true });
    assert.equal(props().length, 4, 'a third hat is added automatically');
    assert.equal(fs.existsSync(creaturePath(root, 'f')), false, 'the female side has its own file and is not affected');

    const warn = P.setPieceOptions(root, 'male_p_head_001', { hairScale: { enabled: false, value: 0.35 } }).warnings;
    assert.deepEqual(warn, []);
    assert.equal(fs.existsSync(creaturePath(root)), false, 'nothing needs it any more');
  });

  it('heels on one pair of shoes give every shoe a creature entry', () => {
    const root = makePack();
    add(root, { comp: 'feet', hasSkin: true });
    add(root, { comp: 'feet', hasSkin: true });
    P.setPieceOptions(root, 'male_feet_000', { heels: { enabled: true, value: 1.1 } });
    const comps = C.readCreature(creaturePath(root)).children.find((c) => c.name === 'pedCompExpressions').children;
    assert.deepEqual(comps.map((c) => [C.field(c, 'pedCompID'), C.field(c, 'pedCompVarIndex'), C.field(c, 'pedCompExpressionIndex')]), [[6, 0, 4], [6, 1, 4]]);
    assert.deepEqual(Y.getOptions(ymtOf(root), { comp: 'feet', prop: false, drawable: '000' }).heels, { enabled: true, value: Math.fround(1.1) });
    assert.equal(texCounts(root, FEET).length, 2);
  });

  it('deleting or moving pieces keeps the creature metadata in step', async () => {
    const root = makePack();
    for (let i = 0; i < 3; i++) add(root, { comp: 'p_head', prop: true });
    P.setPieceOptions(root, 'male_p_head_000', { hairScale: { enabled: true, value: 0.4 } });
    const count = () => C.readCreature(creaturePath(root)).children.find((c) => c.name === 'pedPropExpressions').children.length;
    assert.equal(count(), 4);
    await P.deletePiece(root, 'male_p_head_002', { trash: makeBin().trash });
    assert.equal(count(), 3, 'dummy + 2 hats');
    P.movePiece(root, 'male_p_head_000', 1);
    assert.equal(P.getPieceOptions(root, 'male_p_head_001').options.hairScale.enabled, true, 'the hair scale moved with the hat');
    assert.equal(count(), 3);
  });

  it('options need a .ymt that lists the piece', () => {
    const root = makePack();
    add(root);
    Y.writeYmt(P.findYmt(root, 'test_pack', 'male'), Y.createModel('test_pack'), { backup: false });
    assert.throws(() => P.getPieceOptions(root, 'male_jbib_000'), /does not list/);
    fs.unlinkSync(P.findYmt(root, 'test_pack', 'male'));
    assert.throws(() => P.getPieceOptions(root, 'male_jbib_000'), /no male \.ymt/);
    assert.throws(() => P.setPieceOptions(root, 'male_jbib_000', { flags: 1 }), /no male \.ymt/);
  });
});
