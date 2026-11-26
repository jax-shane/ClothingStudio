'use strict';
// Covers src/lib/spbuild.js - building a pack as a single-player DLC pack (dlc.rpf). The archive is opened again with the
// reader that reads the game's own archives, and checked against the layout of the game's clothing DLCs: what is inside,
// what content.xml registers (every registered file must really be in the archive), and that the textures survived.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/lib/packops');
const SP = require('../src/lib/spbuild');
const ytd = require('../src/lib/ytd');
const { Rpf, FileSource } = require('../src/lib/rpf');
const H = require('./helpers');
const { makePack, add, tex, tempDir, sameColour, RED, GREEN, BLUE } = H;

const opened = [];                                  // the archives the tests read: closed before the temporary folders are removed
after(() => { for (const s of opened.splice(0)) s.close(); H.cleanup(); });   // (Windows cannot remove a folder while a file in it is open)

const openRpf = (f) => { const s = new FileSource(f); opened.push(s); return new Rpf(null, s, 0, path.basename(f), s.size, ''); };
const files = (r) => r.entries.filter((e) => e.kind !== 'dir').map((e) => e.path.slice(r.path.length + 1)).sort();
const entry = (r, p) => r.entries.find((e) => e.path === r.path + '/' + p.toLowerCase());
const child = (r, n) => r.children().find((c) => c.name.toLowerCase() === n.toLowerCase());
const text = (r, p) => r.extract(entry(r, p)).toString('utf8');
const afterCaret = (f) => f.slice(f.indexOf('^') + 1);
/** a deliberately simple well-formedness check: every tag closes in order */
function wellFormed(xml) {
  const stack = [];
  for (const m of xml.replace(/<\?[\s\S]*?\?>/g, '').matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (!m[1]) stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

/** a pack with a top (two textures), shoes with skin and a hat */
function samplePack() {
  const root = makePack('my_pack');
  add(root, { gender: 'male', comp: 'jbib', hasSkin: false, textures: [tex(RED), tex(GREEN)] });
  add(root, { gender: 'female', comp: 'feet', hasSkin: true, textures: [tex(BLUE)] });
  add(root, { gender: 'male', prop: true, comp: 'p_head', textures: [tex(RED)] });
  return root;
}
const build = (root, name) => { const out = path.join(tempDir('cs_sp_out'), 'result'); return { out, report: SP.buildSinglePlayer(root, out, name) }; };

describe('a single-player build', () => {
  const root = samplePack();
  const { out, report } = build(root, 'Sp_Pack');                 // the name is lower-cased
  const dlc = openRpf(path.join(out, 'dlc.rpf'));

  it('writes dlc.rpf and the install notes into the folder, and reports what it made', () => {
    assert.deepEqual(fs.readdirSync(out).sort(), ['INSTALL.txt', 'dlc.rpf']);
    assert.equal(report.name, 'sp_pack');
    assert.equal(report.target, 'singleplayer');
    assert.equal(report.dlclist, '<Item>dlcpacks:/sp_pack/</Item>');
    assert.deepEqual(report.archives.map((a) => a.name), ['sp_pack_female.rpf', 'sp_pack_male.rpf', 'sp_pack_male_p.rpf']);
    assert.ok(report.bytes === fs.statSync(path.join(out, 'dlc.rpf')).size);
    const notes = fs.readFileSync(path.join(out, 'INSTALL.txt'), 'utf8');
    assert.ok(notes.includes('<Item>dlcpacks:/sp_pack/</Item>') && notes.includes('mods\\update\\x64\\dlcpacks'));
  });

  it('dlc.rpf is laid out like the game\'s clothing DLCs', () => {
    assert.deepEqual(files(dlc), [
      'common/data/mp_f_freemode_01_sp_pack.meta', 'common/data/mp_m_freemode_01_sp_pack.meta', 'content.xml', 'setup2.xml',
      'x64/models/cdimages/sp_pack_female.rpf', 'x64/models/cdimages/sp_pack_male.rpf', 'x64/models/cdimages/sp_pack_male_p.rpf',
    ]);
    assert.equal(dlc.encryption, 0x4e45504f, 'an OPEN archive, like the ones OpenIV and CodeWalker write');
  });

  it('each gender archive holds the .ymt at its root and a dictionary folder of plain file names (no ^)', () => {
    const male = child(dlc, 'sp_pack_male.rpf');
    const j = (n) => afterCaret(P.ytdFile('male', false, 'sp_pack', 'jbib', 0, n, false));
    assert.deepEqual(files(male), [
      'mp_m_freemode_01_sp_pack.ymt',
      'mp_m_freemode_01_sp_pack/' + afterCaret(P.yddFile('male', false, 'sp_pack', 'jbib', 0, false)),
      'mp_m_freemode_01_sp_pack/' + j('a'), 'mp_m_freemode_01_sp_pack/' + j('b'),
    ].sort());
    assert.ok(files(male).includes('mp_m_freemode_01_sp_pack/jbib_000_u.ydd'));
    const female = child(dlc, 'sp_pack_female.rpf');
    assert.deepEqual(files(female).filter((f) => !f.endsWith('.ymt')).sort(), ['mp_f_freemode_01_sp_pack/feet_000_r.ydd', 'mp_f_freemode_01_sp_pack/feet_diff_000_a_whi.ytd']);
  });

  it('props go to the _p archive, in the dictionary of their own', () => {
    assert.deepEqual(files(child(dlc, 'sp_pack_male_p.rpf')), ['mp_m_freemode_01_p_sp_pack/p_head_000.ydd', 'mp_m_freemode_01_p_sp_pack/p_head_diff_000_a.ytd']);
  });

  it('the textures and the .ymt come through whole, with the page flags in the table', () => {
    const male = child(dlc, 'sp_pack_male.rpf');
    const srcDir = path.join(root, 'stream', '[male]', 'jbib');
    /** the standalone file again: the version is in the top nibbles of the two page flags, so the header can be rebuilt from the table */
    const standalone = (x) => {
      const h = Buffer.alloc(16);
      h.writeUInt32LE(0x37435352, 0); h.writeUInt32LE(((x.gflags >>> 28) & 15) | (((x.sflags >>> 28) & 15) << 4), 4);
      h.writeUInt32LE(x.sflags >>> 0, 8); h.writeUInt32LE(x.gflags >>> 0, 12);
      return { header: h, file: Buffer.concat([h, require('zlib').deflateRawSync(x.buf)]) };
    };
    for (const [letter, colour] of [['a', RED], ['b', GREEN]]) {
      const e = entry(male, 'mp_m_freemode_01_sp_pack/jbib_diff_000_' + letter + '_uni.ytd');
      assert.deepEqual([e.kind, e.sflags, e.gflags >>> 0], ['res', 0x20000, 0xd0020007]);
      const x = male.extract(e), s = standalone(x);
      const original = fs.readFileSync(path.join(srcDir, P.ytdFile('male', false, 'my_pack', 'jbib', 0, letter, false)));
      assert.ok(s.header.equals(original.subarray(0, 16)), 'the header rebuilt from the table is the file\'s own header (version, page flags)');
      const d = ytd.decodeTexture(ytd.readYtd(s.file));
      assert.ok(sameColour([d.rgba[0], d.rgba[1], d.rgba[2]], colour), 'texture ' + letter);
      assert.equal(d.width, 1024);
    }
    const y = entry(male, 'mp_m_freemode_01_sp_pack.ymt');
    assert.equal(y.kind, 'res');
    const Y = require('../src/lib/ymt');
    const model = Y.readYmt(standalone(male.extract(y)).file);
    assert.equal(model.comps.find((c) => c.slot === Y.COMP_SLOT.jbib).drawables.length, 1, 'the one top is listed in the .ymt');
  });

  it('content.xml and setup2.xml are well formed and agree with each other', () => {
    const content = text(dlc, 'content.xml'), setup = text(dlc, 'setup2.xml');
    assert.ok(wellFormed(content) && wellFormed(setup));
    assert.match(setup, /<deviceName>dlc_sp_pack<\/deviceName>/);
    assert.match(setup, /<nameHash>sp_pack<\/nameHash>/);
    assert.match(setup, /<datFile>content\.xml<\/datFile>/);
    assert.match(setup, /<type>EXTRACONTENT_COMPAT_PACK<\/type>/);
    assert.match(setup, /<Item>SP_PACK_AUTOGEN<\/Item>/);
    assert.match(content, /<changeSetName>SP_PACK_AUTOGEN<\/changeSetName>/);
    assert.match(setup, /<timeStamp>\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d<\/timeStamp>/);
  });

  it('everything content.xml registers is really in the archive, and every archive and meta file is registered', () => {
    const content = text(dlc, 'content.xml');
    const registered = [...content.matchAll(/<filename>dlc_sp_pack:\/([^<]+)<\/filename>\s*<fileType>(\w+)<\/fileType>/g)].map((m) => ({ file: m[1], type: m[2] }));
    const inArchive = new Set(files(dlc).map((f) => f.toLowerCase()));
    for (const r of registered) assert.ok(inArchive.has(r.file.replace('%PLATFORM%', 'x64').toLowerCase()), r.file + ' is registered but missing');
    assert.deepEqual(registered.map((r) => r.type).sort(), ['RPF_FILE', 'RPF_FILE', 'RPF_FILE', 'SHOP_PED_APPAREL_META_FILE', 'SHOP_PED_APPAREL_META_FILE']);
    const enabled = [...content.slice(content.indexOf('<filesToEnable>')).matchAll(/<Item>dlc_sp_pack:\/([^<]+)<\/Item>/g)].map((m) => m[1]);
    assert.deepEqual(enabled.sort(), registered.map((r) => r.file).sort(), 'the change set enables exactly what is registered');
    for (const f of files(dlc)) if (/\.(rpf|meta)$/.test(f)) assert.ok(registered.some((r) => r.file.replace('%PLATFORM%', 'x64') === f), f + ' is in the archive but not registered');
  });

  it('the shop metadata is the one the FiveM build writes, and names the same dictionary as the archive', () => {
    const meta = text(dlc, 'common/data/mp_m_freemode_01_sp_pack.meta');
    assert.match(meta, /<pedName>mp_m_freemode_01<\/pedName>/);
    assert.match(meta, /<dlcName>sp_pack<\/dlcName>/);
    assert.match(meta, /<fullDlcName>mp_m_freemode_01_sp_pack<\/fullDlcName>/);
  });
});

describe('heels and hair scale', () => {
  it('the creature metadata goes into creaturemetadata.rpf under the name the shop metadata asks for, and is registered', () => {
    const root = samplePack();
    P.setPieceOptions(root, 'female_feet_000', { heels: { enabled: true, value: 1 } });
    const { out } = build(root, 'heels_pack');
    const dlc = openRpf(path.join(out, 'dlc.rpf'));
    assert.ok(files(dlc).includes('x64/anim/creaturemetadata.rpf'));
    const cm = child(dlc, 'creaturemetadata.rpf');
    assert.deepEqual(files(cm), ['mp_creaturemetadata_f_heels_pack.ymt']);
    assert.match(text(dlc, 'common/data/mp_f_freemode_01_heels_pack.meta'), /<creatureMetaData>mp_creaturemetadata_f_heels_pack<\/creatureMetaData>/);
    assert.match(text(dlc, 'content.xml'), /dlc_heels_pack:\/%PLATFORM%\/anim\/creaturemetadata\.rpf<\/filename>\s*<fileType>RPF_FILE<\/fileType>/);
  });
});

describe('when it cannot build', () => {
  it('an empty pack: nothing to build, and nothing left behind', () => {
    const root = makePack('empty_pack');
    const out = path.join(tempDir('cs_sp_out'), 'result');
    assert.throws(() => SP.buildSinglePlayer(root, out, 'empty_pack'), /nothing to build/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(out + '.cs_building'), false);
  });

  it('a failure part way (here: the conversion) leaves no temporary work folder behind', () => {
    const root = samplePack();
    const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cs_sp_') && !n.startsWith('cs_sp_out')).sort();
    const before = leftovers();
    const out = path.join(tempDir('cs_sp_out'), 'result');
    // a pack whose stream has a stray ".rpf" with the wrong content makes the archive writer refuse
    fs.mkdirSync(path.join(root, 'stream', 'extra'), { recursive: true });
    fs.writeFileSync(path.join(root, 'stream', 'extra', 'mp_m_freemode_01_my_pack^broken.rpf'), 'not an archive');
    assert.throws(() => SP.buildSinglePlayer(root, out, 'my_pack'), /not an archive/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(out + '.cs_building'), false);
    assert.deepEqual(leftovers(), before);
  });

  it('a bad name, a folder that is not empty, a folder inside the pack', () => {
    const root = samplePack();
    const out = path.join(tempDir('cs_sp_out'), 'result');
    assert.throws(() => SP.buildSinglePlayer(root, out, 'has space'), /letters, digits and underscores/);
    fs.mkdirSync(out); fs.writeFileSync(path.join(out, 'x.txt'), 'x');
    assert.throws(() => SP.buildSinglePlayer(root, out, 'good_name'), /not empty/);
    assert.throws(() => SP.buildSinglePlayer(root, path.join(root, 'inside'), 'good_name'), /outside the pack/);
    assert.deepEqual(fs.readdirSync(out), ['x.txt'], 'the existing folder was not touched');
  });

  it('a file in the stream folder it does not know is left out and mentioned, the rest still builds', () => {
    const root = samplePack();
    fs.writeFileSync(path.join(root, 'stream', 'notes.txt'), 'hello');
    const { out, report } = build(root, 'notes_pack');
    assert.ok(report.notes.some((n) => /notes\.txt was left out/.test(n)), report.notes.join(' | '));
    assert.ok(files(openRpf(path.join(out, 'dlc.rpf'))).includes('content.xml'));
  });

  it('the pack itself is not changed by a build', () => {
    const root = samplePack();
    const before = H.snapshot(root);
    build(root, 'unchanged');
    assert.deepEqual(H.snapshot(root), before);
  });
});
