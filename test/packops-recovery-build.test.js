'use strict';
// Covers the safety net and the output of src/lib/packops.js:
//  * crash recovery - a child process is killed in the middle of a move / an add, then recoverPack puts the pack
//    back exactly as it was (the on-disk operation journal), plus the guard rails of the recovery itself;
//  * buildResource - the clean FiveM resource written by "Build": file list, fxmanifest, .meta files, rebuilt .ymt,
//    creature metadata only when something needs it, renaming the resource, and failing without leaving debris.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../src/lib/packops');
const Y = require('../src/lib/ymt');
const C = require('../src/lib/creature');
const { scanPack } = require('../src/lib/pack');
const H = require('./helpers');
const { tex, add, tree, snapshot, makePack, tempDir, RED, GREEN, BLUE, YELLOW } = H;

after(H.cleanup);

const PACKOPS = path.join(__dirname, '..', 'src', 'lib', 'packops.js');

/** run `body` in a fresh node process that is killed (exit code 42) when `fsFn` is called for the `at`-th time */
function crashIn(fsFn, at, { before = false } = {}, call) {
  const script = `
    const fs = require('fs');
    const P = require(${JSON.stringify(PACKOPS)});
    const real = fs[${JSON.stringify(fsFn)}];
    let n = 0;
    fs[${JSON.stringify(fsFn)}] = function (...a) {
      n += 1;
      if (n === ${at} && ${before}) process.exit(42);                 // killed just BEFORE this call happens
      const r = real.apply(this, a);
      if (n === ${at} && !${before}) process.exit(42);                // killed right AFTER it happened, before it was written to the journal
      return r;
    };
    ${call}
    process.exit(0);
  `;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
}

function threeTops() {
  const root = makePack();
  add(root, { marker: 'A', textures: [tex(RED)] });
  add(root, { marker: 'B', textures: [tex(GREEN), tex(BLUE)] });
  add(root, { marker: 'C', textures: [tex(YELLOW)] });
  return root;
}

describe('crash recovery', () => {
  it('a move killed half way is undone completely when the pack is opened again', () => {
    for (const at of [4, 10]) {                                     // 14 renames: 7 files parked, then 7 placed
      const root = threeTops();
      const before = snapshot(root);
      const run = crashIn('renameSync', at, { before: true }, `P.movePiece(${JSON.stringify(root)}, 'male_jbib_002', 0);`);
      assert.equal(run.status, 42, run.stderr);
      assert.equal(fs.existsSync(path.join(root, '.cs_journal.json')), true, 'the journal is on disk');
      assert.notDeepEqual(snapshot(root), before, 'the pack really is in a half-moved state');

      const rec = P.recoverPack(root);
      assert.equal(rec.rolledBack, at - 1, `the ${at - 1} renames that had happened were undone`);
      assert.deepEqual(rec.stuck, []);
      assert.deepEqual(snapshot(root), before, 'every file is back under its old name, .ymt untouched');
      assert.equal(fs.existsSync(path.join(root, '.cs_journal.json')), false);
    }
  });

  it('a rename that happened but was not yet journaled is found by its temporary .cs_mv name', () => {
    const root = threeTops();
    const before = snapshot(root);
    const run = crashIn('renameSync', 4, { before: false }, `P.movePiece(${JSON.stringify(root)}, 'male_jbib_002', 0);`);
    assert.equal(run.status, 42, run.stderr);
    const rec = P.recoverPack(root);
    assert.equal(rec.rolledBack, 3);
    assert.equal(rec.restored.length, 1, 'the un-journaled parked file was restored from its .cs_mv name');
    assert.deepEqual(snapshot(root), before);
  });

  it('an add killed after the model and a texture were copied removes the half-made piece', () => {
    const root = makePack();
    add(root, { marker: 'keep' });
    const before = snapshot(root);
    const spec = { gender: 'male', prop: false, comp: 'jbib', hasSkin: false, ydd: H.fakeYdd('new'), textures: [{ kind: 'ytd', path: H.solidYtd(...RED) }, { kind: 'ytd', path: H.solidYtd(...GREEN) }, { kind: 'ytd', path: H.solidYtd(...BLUE) }] };
    const run = crashIn('copyFileSync', 3, { before: true }, `P.addPiece(${JSON.stringify(root)}, ${JSON.stringify(spec)});`);
    assert.equal(run.status, 42, run.stderr);
    assert.notDeepEqual(snapshot(root), before, 'the new model and first texture are on disk');
    assert.equal(P.recoverPack(root).rolledBack, 2);
    assert.deepEqual(snapshot(root), before);
  });

  it('a pack that was never interrupted is left alone', () => {
    const root = threeTops();
    const before = snapshot(root);
    assert.deepEqual(P.recoverPack(root), { rolledBack: 0, restored: [], stuck: [] });
    assert.deepEqual(snapshot(root), before);
  });

  it('stray .cs_mv files: put back when their name is free, reported when it is taken', () => {
    const root = threeTops();
    const freeName = path.join(root, 'stream', '[male]', 'jbib', 'mp_m_freemode_01_test_pack^jbib_000_u.ydd');
    fs.renameSync(freeName, freeName + '.cs_mv');
    const takenName = path.join(root, 'stream', '[male]', 'jbib', 'mp_m_freemode_01_test_pack^jbib_001_u.ydd');
    fs.copyFileSync(takenName, takenName + '.cs_mv');
    const rec = P.recoverPack(root);
    assert.deepEqual(rec.restored, ['mp_m_freemode_01_test_pack^jbib_000_u.ydd']);
    assert.deepEqual(rec.stuck, ['mp_m_freemode_01_test_pack^jbib_001_u.ydd.cs_mv']);
    assert.equal(fs.existsSync(freeName), true);
    assert.equal(fs.existsSync(takenName + '.cs_mv'), true, 'never overwrites a real file');
  });

  it('a damaged journal, or one that points outside the pack, cannot hurt anything', () => {
    const root = threeTops();
    const before = snapshot(root);
    const outside = path.join(tempDir('cs_outside'), 'precious.txt');
    fs.writeFileSync(outside, 'do not delete');
    fs.writeFileSync(path.join(root, '.cs_journal.json'), JSON.stringify([['new', outside], ['mv', outside, path.join(root, 'x')]]));
    assert.equal(P.recoverPack(root).rolledBack, 0);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'do not delete');
    assert.deepEqual(snapshot(root), before);

    fs.writeFileSync(path.join(root, '.cs_journal.json'), '{ this is not json');
    assert.deepEqual(P.recoverPack(root), { rolledBack: 0, restored: [], stuck: [] });
    assert.equal(fs.existsSync(path.join(root, '.cs_journal.json')), false, 'an unreadable journal is dropped');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
/** two tops (one shows skin), a hat with hair scale, heels, a female top, plus the leftovers a real pack collects */
function bigPack() {
  const root = makePack();
  add(root, { marker: 'm-top0', textures: [tex(RED), tex(GREEN)] });
  add(root, { marker: 'm-top1', hasSkin: true, textures: [tex(BLUE)] });
  add(root, { marker: 'm-hat', comp: 'p_head', prop: true, textures: [tex(YELLOW)] });
  add(root, { marker: 'm-shoe', comp: 'feet', hasSkin: true, textures: [tex(RED)] });
  add(root, { marker: 'f-top', gender: 'female', textures: [tex(GREEN)] });
  P.setPieceOptions(root, 'male_p_head_000', { hairScale: { enabled: true, value: 0.35 } });
  P.setPieceOptions(root, 'male_feet_000', { audio: 'shoe_high_heels', heels: { enabled: true, value: 1.2 } });
  const jbib = path.join(root, 'stream', '[male]', 'jbib');
  fs.writeFileSync(path.join(jbib, 'old_texture.ytd.bak'), 'backup');                     // none of these may reach the build
  fs.writeFileSync(path.join(jbib, 'half_written.tmp'), 'tmp');
  fs.writeFileSync(path.join(jbib, 'x.ydd.cs_mv'), 'parked');
  fs.writeFileSync(path.join(root, 'first_person_alternates_test_pack.meta'), 'A mp_m_freemode_01_test_pack^x B test_pack C test_pack_extra');
  return root;
}
const outDir = () => path.join(tempDir('cs_out'), 'built');

describe('buildResource', () => {
  it('writes a clean resource: manifest, .meta files, rebuilt .ymt, creature metadata, only the real pieces', () => {
    const root = bigPack();
    const out = outDir();
    const rep = P.buildResource(root, out);
    assert.deepEqual(tree(out), [
      'first_person_alternates_test_pack.meta',
      'fxmanifest.lua',
      'mp_f_freemode_01_test_pack.meta',
      'mp_m_freemode_01_test_pack.meta',
      'stream/[female]/jbib/mp_f_freemode_01_test_pack^jbib_000_u.ydd',
      'stream/[female]/jbib/mp_f_freemode_01_test_pack^jbib_diff_000_a_uni.ytd',
      'stream/[male]/feet/mp_m_freemode_01_test_pack^feet_000_r.ydd',
      'stream/[male]/feet/mp_m_freemode_01_test_pack^feet_diff_000_a_whi.ytd',
      'stream/[male]/jbib/mp_m_freemode_01_test_pack^jbib_000_u.ydd',
      'stream/[male]/jbib/mp_m_freemode_01_test_pack^jbib_001_r.ydd',
      'stream/[male]/jbib/mp_m_freemode_01_test_pack^jbib_diff_000_a_uni.ytd',
      'stream/[male]/jbib/mp_m_freemode_01_test_pack^jbib_diff_000_b_uni.ytd',
      'stream/[male]/jbib/mp_m_freemode_01_test_pack^jbib_diff_001_a_whi.ytd',
      'stream/[male]/p_head/mp_m_freemode_01_p_test_pack^p_head_000.ydd',
      'stream/[male]/p_head/mp_m_freemode_01_p_test_pack^p_head_diff_000_a.ytd',
      'stream/mp_creaturemetadata_m_test_pack.ymt',
      'stream/mp_f_freemode_01_test_pack.ymt',
      'stream/mp_m_freemode_01_test_pack.ymt',
    ]);
    assert.equal(rep.files, 11, 'models + textures copied (backups, temp files and parked files are not)');
    assert.deepEqual(rep.ymt.sort(), ['mp_f_freemode_01_test_pack.ymt', 'mp_m_freemode_01_test_pack.ymt']);
    assert.equal(fs.existsSync(out + '.cs_building'), false, 'the work folder is gone');
    assert.equal(fs.existsSync(path.join(root, 'stream', 'mp_m_freemode_01_test_pack.ymt')), true, 'the source pack is untouched');

    const lua = fs.readFileSync(path.join(out, 'fxmanifest.lua'), 'utf8');
    assert.match(lua, /fx_version 'cerulean'/);
    assert.match(lua, /data_file 'SHOP_PED_APPAREL_META_FILE' 'mp_m_freemode_01_test_pack\.meta'/);
    assert.match(lua, /data_file 'PED_FIRST_PERSON_ALTERNATE_DATA' 'first_person_alternates_test_pack\.meta'/);
    assert.match(lua, /'first_person_alternates_test_pack\.meta'/, 'also listed under files { }');
  });

  it('the built .ymt matches the built files, keeps the options, and the creature metadata covers the hat and shoe', () => {
    const out = outDir();
    P.buildResource(bigPack(), out);
    const male = Y.readYmt(P.findYmt(out, 'test_pack', 'male'));
    const items = scanPack(out).items.filter((i) => i.gender === 'male');
    assert.deepEqual(Y.compare(male, items), { diffs: [], missing: [] });
    assert.equal(Y.getOptions(male, { comp: 'feet', prop: false, drawable: '000' }).audio, 'shoe_high_heels');
    assert.deepEqual(Y.getOptions(male, { comp: 'feet', prop: false, drawable: '000' }).heels, { enabled: true, value: Math.fround(1.2) });
    assert.equal(Y.getOptions(male, { comp: 'p_head', prop: true, drawable: '000' }).hairScale.enabled, true);
    assert.deepEqual(Y.creatureNeeds(male), { hats: 1, heels: 1 });

    const cm = C.readCreature(path.join(out, 'stream', 'mp_creaturemetadata_m_test_pack.ymt'));
    assert.equal(cm.children.find((c) => c.name === 'pedPropExpressions').children.length, 2, 'dummy + the one hat');
    assert.equal(cm.children.find((c) => c.name === 'pedCompExpressions').children.length, 1, 'the one pair of shoes');
    const female = Y.readYmt(P.findYmt(out, 'test_pack', 'female'));
    assert.deepEqual(Y.compare(female, scanPack(out).items.filter((i) => i.gender === 'female')), { diffs: [], missing: [] });
  });

  it('can build under a new resource name: every file name, the .ymt, the .meta and the data files follow', () => {
    const out = outDir();
    const rep = P.buildResource(bigPack(), out, 'new_name');
    assert.equal(rep.name, 'new_name');
    const files = tree(out);
    assert.ok(files.includes('stream/[male]/jbib/mp_m_freemode_01_new_name^jbib_000_u.ydd'));
    assert.ok(files.includes('stream/[male]/p_head/mp_m_freemode_01_p_new_name^p_head_diff_000_a.ytd'));
    assert.ok(files.includes('stream/mp_creaturemetadata_m_new_name.ymt'));
    assert.ok(files.includes('first_person_alternates_new_name.meta'));
    assert.ok(!files.some((f) => f.includes('test_pack')), 'nothing keeps the old name');
    const pack = scanPack(out);
    assert.equal(pack.dlcName, 'new_name');
    assert.equal(Y.readYmt(P.findYmt(out, 'new_name', 'male')).name, 'new_name');
    assert.match(fs.readFileSync(path.join(out, 'mp_m_freemode_01_new_name.meta'), 'utf8'), /<dlcName>new_name<\/dlcName>/);
    assert.equal(fs.readFileSync(path.join(out, 'first_person_alternates_new_name.meta'), 'utf8'), 'A mp_m_freemode_01_new_name^x B test_pack C test_pack_extra',
      'only whole name parts are replaced');
  });

  it('writes no creature metadata when no hat uses hair scale and no shoe uses heels - even if the old pack still has a stale file', () => {
    const root = bigPack();
    // switch hair scale and heels off in the .ymt directly, so the creature file in the pack stays behind, out of date
    const file = P.findYmt(root, 'test_pack', 'male');
    const m = Y.readYmt(file);
    Y.setOptions(m, { comp: 'p_head', prop: true, drawable: '000' }, { hairScale: { enabled: false, value: 0.35 } });
    Y.setOptions(m, { comp: 'feet', prop: false, drawable: '000' }, { heels: { enabled: false, value: 1 } });
    Y.writeYmt(file, m, { backup: false });
    assert.equal(fs.existsSync(path.join(root, 'stream', 'mp_creaturemetadata_m_test_pack.ymt')), true, 'stale file is in the source pack');
    const out = outDir();
    P.buildResource(root, out);
    assert.deepEqual(tree(out).filter((f) => f.includes('creaturemetadata')), []);
  });

  it('lists pieces that have files but are missing from the .ymt, and says so', () => {
    const root = makePack();
    add(root, { marker: 'a' });
    add(root, { marker: 'b', textures: [tex(RED), tex(GREEN)] });
    Y.writeYmt(P.findYmt(root, 'test_pack', 'male'), Y.createModel('test_pack'), { backup: false });     // the .ymt forgot both
    const out = outDir();
    const rep = P.buildResource(root, out);
    assert.equal(rep.notes.filter((n) => /was missing from the \.ymt and was added/.test(n)).length, 2);
    const items = scanPack(out).items.filter((i) => i.gender === 'male');
    assert.deepEqual(Y.compare(Y.readYmt(P.findYmt(out, 'test_pack', 'male')), items), { diffs: [], missing: [] });
  });

  it('a pack with only one gender builds only that gender', () => {
    const root = makePack();
    add(root, { gender: 'female' });
    fs.unlinkSync(P.findYmt(root, 'test_pack', 'male'));
    const out = outDir();
    P.buildResource(root, out);
    const files = tree(out);
    assert.ok(files.includes('mp_f_freemode_01_test_pack.meta'));
    assert.ok(!files.includes('mp_m_freemode_01_test_pack.meta'));
  });

  it('refuses unsafe targets and bad names without writing anything', () => {
    const root = bigPack();
    const taken = tempDir('cs_out');
    fs.writeFileSync(path.join(taken, 'something.txt'), 'x');
    assert.throws(() => P.buildResource(root, taken), /not empty/);
    assert.throws(() => P.buildResource(root, path.join(root, 'build')), /outside the pack/);
    assert.throws(() => P.buildResource(root, root), /not empty|outside the pack/);
    assert.throws(() => P.buildResource(root, outDir(), 'bad name!'), /letters, digits and underscores/);
    assert.deepEqual(fs.readdirSync(taken), ['something.txt']);
    assert.equal(fs.existsSync(path.join(root, 'build')), false);
  });

  it('an empty existing folder is fine, and a failure part way leaves no debris behind', () => {
    const root = bigPack();
    const empty = tempDir('cs_out');
    P.buildResource(root, empty);
    assert.ok(fs.existsSync(path.join(empty, 'fxmanifest.lua')));

    fs.writeFileSync(P.findYmt(root, 'test_pack', 'male'), 'this .ymt is damaged');
    const out = outDir();
    assert.throws(() => P.buildResource(root, out), /RSC7/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(out + '.cs_building'), false, 'the half-built work folder is removed so the next try is not blocked');
  });
});
