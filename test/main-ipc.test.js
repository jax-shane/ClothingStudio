'use strict';
// Covers the wiring of main.js: it is loaded with a fake `electron` module that records the IPC handlers and the dialogs, and the
// handlers are called the way the page calls them (ipcRenderer.invoke). Checks the remembered dialog folders, the texture size
// handling, building for FiveM and for single player, and the language of the dialogs and error messages.
// Nothing opens a window; the files are made in a temporary folder.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = require('../src/lib/packops');
const ytd = require('../src/lib/ytd');
const { Rpf, FileSource } = require('../src/lib/rpf');
const tools = require('../tools/i18n');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cs_userdata_'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs_ipc_'));
const handlers = new Map(), listeners = new Map(), dialogs = [];
let nextOpen = null, nextSave = null;
const system = { locale: 'en-US', preferred: ['en-US'] };
const fake = {
  app: { getPath: () => userData, getLocale: () => system.locale, getPreferredSystemLanguages: () => system.preferred, whenReady: () => new Promise(() => {}), on() {}, quit() {}, exit() {} },
  BrowserWindow: class { static getAllWindows() { return []; } static fromWebContents() { return null; } },
  ipcMain: { handle: (n, f) => handlers.set(n, f), on: (n, f) => listeners.set(n, f) },
  dialog: {
    showOpenDialog: async (w, o) => { dialogs.push({ kind: 'open', title: o.title, defaultPath: o.defaultPath }); return nextOpen; },
    showSaveDialog: async (w, o) => { dialogs.push({ kind: 'save', title: o.title, defaultPath: o.defaultPath }); return nextSave; },
    showMessageBoxSync() { return 0; },
  },
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({}), getDisplayMatching: () => ({}) },
  shell: { trashItem: async () => {} },
};
const realLoad = Module._load;
before(() => {
  Module._load = function (request) { return request === 'electron' ? fake : realLoad.apply(this, arguments); };
  require('../main.js');
  Module._load = realLoad;
});
after(() => { fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); });

const invoke = async (name, ...args) => handlers.get(name)({ sender: null }, ...args);   // async: a handler that throws becomes a rejection, as with ipcRenderer.invoke
const settings = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
const mkdir = (n) => { const d = path.join(work, n); fs.mkdirSync(d, { recursive: true }); return d; };
const last = () => dialogs[dialogs.length - 1];

describe('remembered folders', () => {
  const downloads = mkdir('downloads'), exportsDir = mkdir('exports'), packs = mkdir('packs'), proj = mkdir('proj');
  const png = path.join(downloads, 'pic.png');
  before(() => fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex')));

  it('image:open starts nowhere, then in the folder of the last picked image', async () => {
    nextOpen = { canceled: false, filePaths: [png] };
    await invoke('image:open');
    await invoke('image:open');
    assert.equal(dialogs[0].defaultPath, undefined);
    assert.equal(dialogs[1].defaultPath, downloads);
    assert.deepEqual(settings().lastDirs, { import: downloads });
  });
  it('a cancelled dialog changes nothing', async () => {
    nextOpen = { canceled: true, filePaths: [] };
    assert.equal(await invoke('image:open'), null);
    assert.equal(last().defaultPath, downloads);
    assert.deepEqual(settings().lastDirs, { import: downloads });
  });
  it('png:save and project:save have their own folders and keep the suggested name', async () => {
    nextSave = { canceled: false, filePath: path.join(exportsDir, 'a.png') };
    await invoke('png:save', 'a.png', 'data:image/png;base64,AAAA');
    nextSave = { canceled: true };
    await invoke('png:save', 'b.png', 'data:image/png;base64,AAAA');
    assert.equal(last().defaultPath, path.join(exportsDir, 'b.png'));
    nextSave = { canceled: false, filePath: path.join(proj, 'x.csproj') };
    await invoke('project:save', 'x.csproj', '{}');
    nextSave = { canceled: true };
    await invoke('png:save', 'c.png', 'data:image/png;base64,AAAA');
    assert.equal(last().defaultPath, path.join(exportsDir, 'c.png'), 'saving a project did not move the PNG export folder');
    nextOpen = { canceled: true, filePaths: [] };
    await invoke('project:open');
    assert.equal(last().defaultPath, proj);
  });
  it('Open pack remembers the folder the packs live in', async () => {
    const made = P.createPack(packs, 'my_pack');
    nextOpen = { canceled: false, filePaths: [made.root] };
    await invoke('pack:open');
    nextOpen = { canceled: true, filePaths: [] };
    await invoke('pack:open');
    assert.equal(last().defaultPath, packs);
    assert.equal(settings().lastDirs.pack, packs);
  });
});

describe('texture sizes through the real handlers', () => {
  let packRoot, fileA;
  const solid = (w, h, r, g, b) => { const px = new Uint8Array(w * h * 4); for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; } return px; };
  const dims = (f) => { const t = ytd.readYtd(f).textures[0]; return [t.width, t.height, t.mips]; };
  before(async () => {
    packRoot = P.createPack(mkdir('sizes'), 'size_pack').root;
    const model = path.join(mkdir('models'), 'm.ydd'); fs.writeFileSync(model, 'FAKE-YDD');
    P.addPiece(packRoot, { gender: 'male', prop: false, comp: 'jbib', hasSkin: false, ydd: model, textures: [{ kind: 'blank' }] });
    listeners.get('drop:path')(null, packRoot);
    await invoke('pack:scan', packRoot);
    const stream = path.join(packRoot, 'stream', '[male]', 'jbib');
    fileA = path.join(stream, fs.readdirSync(stream).find((n) => /_diff_000_a_uni\.ytd$/.test(n)));
  });

  it('tex:save at the texture\'s own size patches the pixels', async () => {
    const r = await invoke('tex:save', fileA, solid(1024, 1024, 255, 0, 0), undefined);
    assert.equal(r.resized, undefined);
    assert.deepEqual(dims(fileA), [1024, 1024, 9]);
    const r2 = await invoke('tex:save', fileA, solid(1024, 1024, 0, 255, 0), { width: 1024, height: 1024 });
    assert.equal(r2.resized, undefined, 'the same size given explicitly still patches');
  });
  it('another width and height rewrites the .ytd at that size and keeps the original as .bak', async () => {
    const r = await invoke('tex:save', fileA, solid(2048, 2048, 0, 0, 255), { width: 2048, height: 2048 });
    assert.equal(r.resized, true);
    assert.deepEqual([r.width, r.height, r.mips], [2048, 2048, 10]);
    assert.deepEqual(dims(fileA), [2048, 2048, 10]);
    assert.deepEqual(dims(fileA + '.bak'), [1024, 1024, 9], 'the .bak is the 1024 original');
  });
  it('bad sizes and mismatched pixels are refused and the file stays as it was', async () => {
    const before = fs.readFileSync(fileA);
    await assert.rejects(() => invoke('tex:save', fileA, solid(1024, 1024, 1, 2, 3), { width: 2048, height: 2048 }), /pixel data is/);
    await assert.rejects(() => invoke('tex:save', fileA, solid(100, 100, 1, 2, 3), { width: 100, height: 100 }), /power of two/);
    await assert.rejects(() => invoke('tex:save', path.join(os.tmpdir(), 'elsewhere.ytd'), solid(4, 4, 0, 0, 0), { width: 4, height: 4 }), /outside the opened pack/);
    assert.ok(fs.readFileSync(fileA).equals(before));
  });
  it('piece:addTextures with kind "copy" copies a texture of the opened pack onto another piece, file for file', async () => {
    const model = path.join(work, 'models', 'm2.ydd'); fs.writeFileSync(model, 'FAKE-YDD 2');
    const added = P.addPiece(packRoot, { gender: 'male', prop: false, comp: 'jbib', hasSkin: false, ydd: model, textures: [{ kind: 'blank' }] });
    const res = await invoke('piece:addTextures', packRoot, added.id, [{ kind: 'copy', ytd: fileA }]);
    assert.equal(res.files.length, 1);
    assert.match(path.basename(res.files[0]), /_diff_001_b_uni\.ytd$/, 'the next letter of the other piece');
    assert.ok(fs.readFileSync(res.files[0]).equals(fs.readFileSync(fileA)), 'the same bytes: size, format and mips as the original');
    await assert.rejects(() => invoke('piece:addTextures', packRoot, added.id, [{ kind: 'copy', ytd: path.join(os.tmpdir(), 'elsewhere.ytd') }]), /outside the opened pack/);
    await assert.rejects(() => invoke('piece:addTextures', packRoot, added.id, [{ kind: 'copy', ytd: path.join(packRoot, 'fxmanifest.lua') }]), /no longer available/);
  });
  it('piece:addTextures: a png marked resize makes a bigger texture; without the mark a wrong size is refused', async () => {
    const tpl = await invoke('piece:template', packRoot, 'male', false, 'jbib', 'male_jbib_000');
    assert.deepEqual([tpl.width, tpl.height], [2048, 2048]);
    await assert.rejects(() => invoke('piece:addTextures', packRoot, 'male_jbib_000', [{ kind: 'png', width: 4096, height: 4096, rgba: solid(1, 1, 1, 1, 1) }]), /must be 2048.2048/);
    const res = await invoke('piece:addTextures', packRoot, 'male_jbib_000', [{ kind: 'png', width: 512, height: 512, resize: true, rgba: solid(512, 512, 9, 99, 199) }]);
    assert.deepEqual(dims(res.files[0]), [512, 512, 8]);
  });
});

describe('Build: a FiveM resource or a single-player pack', () => {
  let packRoot;
  before(async () => {
    packRoot = P.createPack(mkdir('buildsrc'), 'my_clothes').root;
    const model = path.join(mkdir('models2'), 'jbib_000_u.ydd'); fs.writeFileSync(model, 'FAKE-YDD');
    P.addPiece(packRoot, { gender: 'male', prop: false, comp: 'jbib', hasSkin: false, ydd: model, textures: [{ kind: 'blank' }] });
    listeners.get('drop:path')(null, packRoot);
    await invoke('pack:scan', packRoot);
  });

  it('the default target is a FiveM resource folder named like the pack', async () => {
    const out = mkdir('out-fivem');
    nextOpen = { canceled: false, filePaths: [out] };
    const rep = await invoke('pack:build', packRoot, 'my_clothes');
    assert.match(last().title, /FiveM resource/);
    assert.equal(rep.root, path.join(out, 'my_clothes'));
    assert.ok(fs.existsSync(path.join(rep.root, 'fxmanifest.lua')));
    assert.ok(fs.existsSync(path.join(rep.root, 'stream')));
    assert.equal(fs.existsSync(path.join(rep.root, 'dlc.rpf')), false);
  });
  it('target "sp" builds a single-player DLC pack: dlc.rpf and INSTALL.txt in a folder named after the pack in lower case', async () => {
    const out = mkdir('out-sp');
    nextOpen = { canceled: false, filePaths: [out] };
    const rep = await invoke('pack:build', packRoot, 'My_Clothes', 'sp');
    assert.match(last().title, /single-player/);
    assert.equal(rep.target, 'singleplayer');
    assert.equal(rep.root, path.join(out, 'my_clothes'));
    assert.equal(rep.dlclist, '<Item>dlcpacks:/my_clothes/</Item>');
    assert.ok(rep.bytes > 0 && rep.files > 0);
    assert.deepEqual(fs.readdirSync(rep.root).sort(), ['INSTALL.txt', 'dlc.rpf']);
    const src = new FileSource(path.join(rep.root, 'dlc.rpf'));
    try {
      const rpf = new Rpf(null, src, 0, 'dlc.rpf', src.size, '');
      const names = rpf.entries.filter((e) => e.kind !== 'dir').map((e) => e.path.slice(rpf.path.length + 1));
      assert.ok(names.includes('content.xml') && names.includes('setup2.xml'), 'the pack is registered: ' + names.join(', '));
    } finally { src.close(); }                       // Windows cannot remove the folder at the end while the file is still open
  });
  it('a name the game cannot use is refused before any dialog opens', async () => {
    const n = dialogs.length;
    await assert.rejects(() => invoke('pack:build', packRoot, 'bad name!', 'sp'), /letters, digits and underscores/);
    assert.equal(dialogs.length, n);
  });
  it('a cancelled folder dialog builds nothing', async () => {
    nextOpen = { canceled: true, filePaths: [] };
    assert.equal(await invoke('pack:build', packRoot, 'my_clothes', 'sp'), null);
  });
});

describe('the language of the dialogs and the error messages', () => {
  const codes = tools.languageCodes().filter((c) => c !== 'pseudo');
  it('lang:get says what was chosen and what the system uses', async () => {
    system.locale = 'de-DE'; system.preferred = ['de-DE', 'en-US'];
    assert.deepEqual(await invoke('lang:get'), { saved: null, system: ['de-DE', 'de-DE', 'en-US'] });
  });
  it('lang:set remembers a choice only when asked to, and refuses things that are not language codes', async () => {
    await invoke('lang:set', 'fr', false);
    assert.equal((await invoke('lang:get')).saved, null, 'picked by the editor itself: not saved');
    await invoke('lang:set', 'fr', true);
    assert.equal((await invoke('lang:get')).saved, 'fr');
    assert.equal(settings().language, 'fr');
    await invoke('lang:set', '', true);
    assert.equal((await invoke('lang:get')).saved, null, 'automatic again');
    assert.equal('language' in settings(), false);
    await assert.rejects(() => invoke('lang:set', '../../etc/passwd', true), /not a language code/);
    await assert.rejects(() => invoke('lang:set', 'en;rm', false), /not a language code/);
  });
  it('error messages and dialog titles are in the language that was set, and English again afterwards', async () => {
    const outside = path.join(os.tmpdir(), 'elsewhere.ytd');
    const ask = () => invoke('tex:save', outside, new Uint8Array(64), { width: 4, height: 4 }).then(() => null, (e) => e.message);
    await invoke('lang:set', 'en', false);
    assert.match(await ask(), /outside the opened pack/);
    if (!codes.length) return;                                                    // no language file yet
    for (const code of codes.slice(0, 3)) {
      await invoke('lang:set', code, false);
      const m = await ask();
      assert.ok(m && !/outside the opened pack/.test(m), `${code}: the message is translated (${m})`);
      nextOpen = { canceled: true, filePaths: [] };
      await invoke('image:open');
      assert.notEqual(last().title, 'Import image', `${code}: the dialog title is translated`);
    }
    await invoke('lang:set', 'en', false);
    assert.match(await ask(), /outside the opened pack/);
  });
});
