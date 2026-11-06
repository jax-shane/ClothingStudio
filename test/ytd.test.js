'use strict';
// Covers src/lib/ytd.js - GTA V texture dictionaries: reading the bundled blank template, size maths for DXT1 / DXT5 /
// A8R8G8B8 mip chains, encode -> decode round trips, patching pixels back into a .ytd (with the one-time .bak and the
// "verify before replacing" safety net, including DXT1's on/off alpha), and renaming the texture inside a dictionary.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ytd = require('../src/lib/ytd');
const { TEMPLATE, SIZE, tempDir, cleanup, solidRgba, sameColour } = require('./helpers');

after(cleanup);

/** a writable copy of the blank template */
function copyTemplate(name = 'tex.ytd') {
  const f = path.join(tempDir('cs_ytd'), name);
  fs.copyFileSync(TEMPLATE, f);
  return f;
}
const pixel = (rgba, w, x, y) => Array.from(rgba.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

describe('reading', () => {
  it('the bundled template is one 1024 x 1024 DXT1 texture with a full mip chain', () => {
    const t = ytd.readYtd(TEMPLATE).textures;
    assert.equal(t.length, 1);
    assert.deepEqual([t[0].name, t[0].width, t[0].height, t[0].formatName, t[0].mips], ['blank_diff_000', SIZE, SIZE, 'DXT1', 9]);
  });

  it('decodes to RGBA of the right size', () => {
    const d = ytd.decodeTexture(ytd.readYtd(TEMPLATE));
    assert.equal(d.rgba.length, SIZE * SIZE * 4);
    assert.equal(d.rgba[3], 255, 'fully opaque grey');
  });

  it('refuses files that are not texture dictionaries', () => {
    const f = path.join(tempDir('cs_ytd'), 'junk.ytd');
    fs.writeFileSync(f, 'not a texture dictionary');
    assert.throws(() => ytd.readYtd(f), /RSC7/);
  });
});

describe('sizes and codecs', () => {
  it('level and chain sizes follow the block layout of each format', () => {
    assert.equal(ytd.levelSize(ytd.FMT.DXT1, 4, 4), 8);
    assert.equal(ytd.levelSize(ytd.FMT.DXT1, 1, 1), 8, 'even a 1 x 1 mip takes a whole block');
    assert.equal(ytd.levelSize(ytd.FMT.DXT5, 8, 8), 4 * 16);
    assert.equal(ytd.levelSize(ytd.FMT.A8R8G8B8, 8, 4), 128);
    assert.equal(ytd.chainSize(ytd.FMT.DXT1, 8, 8, 4), 4 * 8 + 8 + 8 + 8);
    assert.throws(() => ytd.levelSize(0x1234, 4, 4), /unsupported texture format 0x1234/);
  });

  it('buildChain produces exactly the size the file layout expects, for every format', () => {
    const w = 64, h = 32, rgba = solidRgba(10, 200, 90).subarray(0, w * h * 4);
    for (const fmt of [ytd.FMT.DXT1, ytd.FMT.DXT5, ytd.FMT.A8R8G8B8]) {
      assert.equal(ytd.buildChain(rgba, w, h, fmt, 7).length, ytd.chainSize(fmt, w, h, 7), ytd.formatName(fmt));
    }
  });

  it('A8R8G8B8 is lossless', () => {
    const w = 16, h = 8, rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + 11) & 255;
    const chain = ytd.buildChain(rgba, w, h, ytd.FMT.A8R8G8B8, 1);
    assert.deepEqual(Buffer.from(ytd.decodeLevel(chain, 0, ytd.FMT.A8R8G8B8, w, h, w * 4)), rgba);
  });

  it('DXT5 keeps a smooth alpha ramp (8 alpha levels per block)', () => {
    const w = 64, h = 8, rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([10, 200, 90, x * 4], (y * w + x) * 4);
    const chain = ytd.buildChain(rgba, w, h, ytd.FMT.DXT5, 1);
    const back = ytd.decodeLevel(chain, 0, ytd.FMT.DXT5, w, h, 0);
    let worst = 0;
    for (let i = 3; i < rgba.length; i += 4) worst = Math.max(worst, Math.abs(back[i] - rgba[i]));
    assert.ok(worst <= 2, 'worst alpha error ' + worst);
    assert.ok(sameColour(pixel(back, w, 5, 5).slice(0, 3), [10, 200, 90]));
  });
});

describe('patching pixels into a .ytd', () => {
  it('a painted texture reads back, the header is untouched, and the original is kept once as .bak', () => {
    const f = copyTemplate();
    const original = fs.readFileSync(f);
    const res = ytd.patchTexture(f, 0, solidRgba(255, 0, 0));
    assert.ok(res.meanError < 1, 'mean error ' + res.meanError);
    assert.equal(res.backup, f + '.bak');
    assert.ok(fs.readFileSync(f + '.bak').equals(original), 'the .bak is the untouched original');
    assert.ok(fs.readFileSync(f).subarray(0, 16).equals(original.subarray(0, 16)), 'resource header unchanged');
    assert.ok(sameColour(pixel(ytd.decodeTexture(ytd.readYtd(f)).rgba, SIZE, 100, 100).slice(0, 3), [255, 0, 0]));

    ytd.patchTexture(f, 0, solidRgba(0, 0, 255));
    assert.ok(fs.readFileSync(f + '.bak').equals(original), 'a second save does not overwrite the .bak');
    assert.ok(sameColour(pixel(ytd.decodeTexture(ytd.readYtd(f)).rgba, SIZE, 100, 100).slice(0, 3), [0, 0, 255]));
    assert.equal(fs.existsSync(f + '.tmp'), false, 'no temp file left behind');
  });

  it('blocky artwork (like flat logos and stripes) comes back almost exactly', () => {
    const f = copyTemplate();
    const rgba = Buffer.alloc(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const on = ((x >> 4) + (y >> 4)) & 1;
      rgba.set(on ? [200, 30, 30, 255] : [30, 30, 200, 255], (y * SIZE + x) * 4);
    }
    const res = ytd.patchTexture(f, 0, rgba, { backup: false });
    assert.ok(res.meanError < 6, 'mean error ' + res.meanError);   // DXT1 stores 5-6-5 bit colours, so a few levels of rounding are normal
    assert.equal(fs.existsSync(f + '.bak'), false, '{ backup: false } writes no .bak');
  });

  it('DXT1 only has on/off alpha: transparent pixels are verified as transparent, not as their hidden colour', () => {
    const f = copyTemplate();
    const rgba = Buffer.alloc(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      // left half: invisible pixels that still carry bright magenta; right half: opaque green
      rgba.set(x < SIZE / 2 ? [255, 0, 255, 0] : [0, 255, 0, 255], (y * SIZE + x) * 4);
    }
    rgba.set([0, 255, 0, 127], (10 * SIZE + 900) * 4);          // below 128 counts as transparent ...
    rgba.set([0, 255, 0, 128], (11 * SIZE + 900) * 4);          // ... 128 and above as opaque
    const res = ytd.patchTexture(f, 0, rgba, { backup: false });
    assert.ok(res.meanError < 1, 'mean error ' + res.meanError);
    const back = ytd.decodeTexture(ytd.readYtd(f)).rgba;
    assert.equal(pixel(back, SIZE, 100, 100)[3], 0, 'transparent stays transparent');
    assert.deepEqual(pixel(back, SIZE, 700, 100).slice(3), [255]);
    assert.ok(sameColour(pixel(back, SIZE, 700, 100).slice(0, 3), [0, 255, 0]));
    assert.equal(pixel(back, SIZE, 900, 10)[3], 0);
    assert.equal(pixel(back, SIZE, 900, 11)[3], 255);
  });

  it('refuses pixel data of the wrong size and leaves the file exactly as it was', () => {
    const f = copyTemplate();
    const before = fs.readFileSync(f);
    assert.throws(() => ytd.patchTexture(f, 0, Buffer.alloc(64 * 64 * 4)), /pixel data is 4096 px, texture is 1024x1024/);
    assert.ok(fs.readFileSync(f).equals(before));
    assert.equal(fs.existsSync(f + '.bak'), false);
    assert.equal(fs.existsSync(f + '.tmp'), false);
  });
});

describe('renaming the texture inside a dictionary', () => {
  it('changes the stored name and keeps the picture', () => {
    const f = copyTemplate();
    ytd.renameInner(f, 'gsp_hat_diff_000_b');
    const t = ytd.readYtd(f);
    assert.equal(t.textures[0].name, 'gsp_hat_diff_000_b');
    assert.equal(t.textures[0].width, SIZE);
    assert.equal(ytd.decodeTexture(t).rgba.length, SIZE * SIZE * 4);
  });

  it('refuses names the game cannot use', () => {
    const f = copyTemplate();
    for (const bad of ['', 'has space', 'x'.repeat(41), '../escape']) assert.throws(() => ytd.renameInner(f, bad), /bad texture name/, JSON.stringify(bad));
  });
});
