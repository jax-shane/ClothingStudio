'use strict';
// Shared helpers for the test suite (not a test file itself). Everything is built from scratch in temporary folders
// under os.tmpdir() - no GTA V files, no real pack, no network. Each test file calls `after(cleanup)`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ytd = require('../src/lib/ytd');
const P = require('../src/lib/packops');
const { scanPack } = require('../src/lib/pack');

const TEMPLATE = path.join(__dirname, '..', 'src', 'lib', 'assets', 'template_blank.ytd');
const SIZE = 1024;                                    // the bundled blank texture is 1024 x 1024 DXT1

const dirs = [];
function tempDir(label = 'cs_test') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), label + '_'));
  dirs.push(d);
  return d;
}
function cleanup() { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); }

// ---- fake models: the pack operations only copy / rename a .ydd, they never parse it, so a few marker bytes will do
let nModel = 0, modelDir = null;
function fakeYdd(marker) {
  modelDir = modelDir || tempDir('cs_models');
  const f = path.join(modelDir, `model_${nModel++}.ydd`);
  fs.writeFileSync(f, Buffer.from('FAKE-YDD:' + marker));
  return f;
}
const markerOf = (file) => fs.readFileSync(file, 'latin1').replace(/^FAKE-YDD:/, '');

// ---- textures: a ready .ytd filled with one colour, made once per colour (copy of the template + patchTexture)
const solids = new Map();
function solidYtd(r, g, b) {
  const key = [r, g, b].join(',');
  if (!solids.has(key)) {
    const f = path.join(tempDir('cs_tex'), `solid_${key.replace(/,/g, '_')}.ytd`);
    fs.copyFileSync(TEMPLATE, f);
    ytd.patchTexture(f, 0, solidRgba(r, g, b), { backup: false });
    solids.set(key, f);
  }
  return solids.get(key);
}
function solidRgba(r, g, b, a = 255) {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; }
  return px;
}
const RED = [255, 0, 0], GREEN = [0, 255, 0], BLUE = [0, 0, 255], YELLOW = [255, 255, 0], WHITE = [255, 255, 255];
const tex = (colour) => ({ kind: 'ytd', path: solidYtd(...colour) });
/** first pixel of a .ytd as [r, g, b] - tells textures apart after files were renamed around */
function colourOf(file) {
  const d = ytd.decodeTexture(ytd.readYtd(file));
  return [d.rgba[0], d.rgba[1], d.rgba[2]];
}
const sameColour = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 8);

// ---- packs
function makePack(name = 'test_pack') {
  return P.createPack(tempDir('cs_pack'), name).root;
}
/** add a piece with a marker model; spec fields override the defaults (male top, one blank texture) */
function add(root, spec = {}) {
  const marker = spec.marker || `piece${nModel}`;
  const { marker: _drop, ...rest } = spec;
  return P.addPiece(root, { gender: 'male', prop: false, comp: 'jbib', hasSkin: false, textures: [{ kind: 'blank' }], ydd: fakeYdd(marker), ...rest });
}
const item = (root, id) => scanPack(root).items.find((i) => i.id === id);
const names = (files) => files.map((f) => path.basename(f)).sort();
/** every file under a folder, relative, '/' separated, sorted - handy for "the pack looks exactly like this" asserts */
function tree(root) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(path.relative(root, p).split(path.sep).join('/')); } };
  walk(root);
  return out.sort();
}
/** relative path -> sha1 of every file: "the pack is byte-for-byte what it was" is one deepEqual */
function snapshot(root) {
  const crypto = require('crypto');
  const out = {};
  for (const rel of tree(root)) out[rel] = crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  return out;
}
/** the .ymt model of one gender, the way the app finds it */
function ymtOf(root, gender = 'male', dlc = 'test_pack') {
  return require('../src/lib/ymt').readYmt(P.findYmt(root, dlc, gender));
}
/** texture count of every piece of one component slot, in number order */
function texCounts(root, slot, gender = 'male') {
  const c = ymtOf(root, gender).comps.find((x) => x.slot === slot);
  return c ? c.drawables.map((d) => d.tex.length) : [];
}
/** a trash function like the app's Recycle Bin: moves the file into `bin` instead of deleting it */
function makeBin() {
  const bin = tempDir('cs_bin');
  const trashed = [];
  return { bin, trashed, trash: async (f) => { trashed.push(path.basename(f)); fs.renameSync(f, path.join(bin, path.basename(f))); } };
}

module.exports = {
  TEMPLATE, SIZE, tempDir, cleanup, fakeYdd, markerOf, solidYtd, solidRgba, tex, colourOf, sameColour,
  RED, GREEN, BLUE, YELLOW, WHITE, makePack, add, item, names, tree, snapshot, ymtOf, texCounts, makeBin,
};
