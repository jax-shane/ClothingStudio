'use strict';
// Covers src/lib/ytd.js - GTA V texture dictionaries: reading the bundled blank template, size maths for DXT1 / DXT5 /
// A8R8G8B8 mip chains, encode -> decode round trips, patching pixels back into a .ytd (with the one-time .bak and the
// "verify before replacing" safety net, including DXT1's on/off alpha), changing a texture's size (a new page layout,
// every format, the refusals), and renaming the texture inside a dictionary.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ytd = require('../src/lib/ytd');
const { loadRsc, flagsToSize } = require('../src/lib/rsc');
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

/** a w x h picture with something to look at: diagonal stripes, a red / green / blue gradient and a hard-edged yellow square */
function pattern(w, h) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, stripe = ((x + y) >> 5) & 1 ? 220 : 40;
    px.set([stripe, (x * 255 / w) | 0, (y * 255 / h) | 0, 255], i);
    if (x > w / 4 && x < w / 2 && y > h / 4 && y < h / 2) px.set([250, 250, 10, 255], i);
  }
  return px;
}

/** a copy of the template whose texture header claims another pixel format (the data is left alone: only the header is read before a resize) */
function templateAs(format, stride, mips) {
  const f = copyTemplate('as_format.ytd');
  const rsc = loadRsc(f), { objOff } = ytd.readYtd(f).textures[0];
  rsc.buf.writeUInt32LE(format, objOff + 0x58);
  rsc.buf.writeUInt16LE(stride, objOff + 0x56);
  rsc.buf[objOff + 0x5d] = mips;
  fs.writeFileSync(f, Buffer.concat([fs.readFileSync(f).subarray(0, 16), zlib.deflateRawSync(rsc.buf)]));
  return f;
}

describe('changing the size of a texture', () => {
  const original = loadRsc(TEMPLATE);

  it('2048 x 2048: reads back, and the file is laid out like the bundled template (one page, 0xCD padding, header bits kept)', () => {
    const f = copyTemplate();
    const before = fs.readFileSync(f);
    const px = pattern(2048, 2048);
    const res = ytd.resizeTexture(f, 0, 2048, 2048, px);
    assert.deepEqual([res.width, res.height, res.mips, res.resized, res.backup], [2048, 2048, 10, true, f + '.bak']);
    assert.ok(res.meanError < 6, 'mean error ' + res.meanError);

    const back = ytd.readYtd(f), t = back.textures[0];
    assert.deepEqual([t.name, t.width, t.height, t.stride, t.formatName, t.mips], ['blank_diff_000', 2048, 2048, 1024, 'DXT1', 10]);
    assert.equal(ytd.decodeTexture(back).rgba.length, 2048 * 2048 * 4);

    const head = fs.readFileSync(f).subarray(0, 16);
    assert.ok(head.subarray(0, 12).equals(before.subarray(0, 12)), 'resource magic, version and system flags are unchanged');
    const rsc = back.rsc;
    assert.equal(rsc.sflags, original.sflags);
    assert.equal(rsc.gflags >>> 0, 0xd0020009, 'one page of 16 x (0x200 << 9) = 4 MiB, version bits kept');
    assert.equal(flagsToSize(rsc.gflags), 0x400000);
    assert.equal(rsc.gfxSize, 0x400000);
    assert.equal(rsc.buf.length, rsc.sysSize + rsc.gfxSize, 'the inflated image is exactly the two segments');
    const chain = ytd.chainSize(t.format, 2048, 2048, t.mips);
    assert.ok(chain <= rsc.gfxSize, 'the pixels fit in the page');
    assert.ok(rsc.buf.subarray(rsc.sysSize + chain).every((b) => b === 0xcd), 'the rest of the page is the usual 0xCD fill');
    assert.ok(fs.readFileSync(f + '.bak').equals(before), 'the original is kept once as .bak');
    assert.equal(fs.existsSync(f + '.tmp'), false);
  });

  it('only the texture header changes in the system segment (width, height, stride, mip count)', () => {
    const f = copyTemplate();
    ytd.resizeTexture(f, 0, 2048, 2048, pattern(2048, 2048));
    const now = loadRsc(f), o = ytd.readYtd(f).textures[0].objOff;
    const allowed = new Set([o + 0x50, o + 0x51, o + 0x52, o + 0x53, o + 0x56, o + 0x57, o + 0x5d]);
    const changed = [];
    for (let i = 0; i < original.sysSize; i++) if (now.buf[i] !== original.buf[i]) changed.push(i);
    assert.ok(changed.length > 0 && changed.every((i) => allowed.has(i)), 'changed offsets: ' + changed.map((i) => '0x' + i.toString(16)).join(' '));
  });

  it('4096 x 4096 (the biggest size): a 16 MiB page', () => {
    const f = copyTemplate();
    const res = ytd.resizeTexture(f, 0, 4096, 4096, pattern(4096, 4096));
    assert.deepEqual([res.width, res.mips], [4096, 11]);
    const back = ytd.readYtd(f);
    assert.equal(back.rsc.gflags >>> 0, 0xd002000b);
    assert.equal(back.rsc.gfxSize, 0x1000000);
    assert.ok(ytd.chainSize(back.textures[0].format, 4096, 4096, 11) <= back.rsc.gfxSize);
    assert.equal(back.textures[0].stride, 2048);
  });

  it('shrinking and non-square sizes work too, and the mip count follows the file\'s own habit (the template stops at 4 x 4)', () => {
    const f = copyTemplate();
    const px = pattern(512, 256);
    const res = ytd.resizeTexture(f, 0, 512, 256, px);
    assert.deepEqual([res.width, res.height, res.mips], [512, 256, 8], '11 levels in a full 1024 chain, the template skips 2 -> 10 - 2');
    const back = ytd.readYtd(f), t = back.textures[0];
    assert.deepEqual([t.width, t.height, t.stride], [512, 256, 256]);
    const d = ytd.decodeTexture(back);
    assert.equal(d.rgba.length, 512 * 256 * 4);
    assert.ok(sameColour(pixel(d.rgba, 512, 200, 100).slice(0, 3), pixel(px, 512, 200, 100).slice(0, 3)), 'a pixel in the middle of a stripe comes back');
    assert.ok(sameColour(pixel(d.rgba, 512, 160, 100).slice(0, 3), [250, 250, 10]), 'so does the yellow square');
    const page = ytd.pageFlagsFor(ytd.chainSize(t.format, 512, 256, 8), original.gflags);
    assert.equal(back.rsc.gfxSize, page.size);
    assert.equal(back.rsc.gflags >>> 0, page.flags);
  });

  it('going back to the original size gives back the template\'s own header and page flags', () => {
    const f = copyTemplate();
    ytd.resizeTexture(f, 0, 2048, 2048, pattern(2048, 2048), { backup: false });
    ytd.resizeTexture(f, 0, SIZE, SIZE, solidRgba(128, 128, 128), { backup: false });
    const back = ytd.readYtd(f), t = back.textures[0];
    assert.ok(fs.readFileSync(f).subarray(0, 16).equals(fs.readFileSync(TEMPLATE).subarray(0, 16)));
    assert.deepEqual([t.width, t.height, t.stride, t.mips], [SIZE, SIZE, 512, 9]);
    assert.equal(back.rsc.gfxSize, original.gfxSize);
    assert.equal(back.rsc.buf.length, original.buf.length);
    assert.equal(fs.existsSync(f + '.bak'), false, '{ backup: false } writes no .bak');
  });

  it('a second resize does not overwrite the .bak', () => {
    const f = copyTemplate();
    const before = fs.readFileSync(f);
    ytd.resizeTexture(f, 0, 2048, 2048, pattern(2048, 2048));
    ytd.resizeTexture(f, 0, 512, 512, pattern(512, 512));
    assert.ok(fs.readFileSync(f + '.bak').equals(before));
  });

  it('DXT5 and A8R8G8B8 files change size as well (stride follows the file, alpha survives)', () => {
    const w = 256, h = 256;
    const f5 = templateAs(ytd.FMT.DXT5, 1024, 9);
    const rgba = pattern(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba[(y * w + x) * 4 + 3] = (x * 255 / w) | 0;      // smooth alpha ramp
    ytd.resizeTexture(f5, 0, w, h, rgba, { backup: false });
    const b5 = ytd.readYtd(f5), t5 = b5.textures[0];
    assert.deepEqual([t5.formatName, t5.width, t5.stride, t5.mips], ['DXT5', 256, 256, 7]);
    const d5 = ytd.decodeTexture(b5).rgba;
    let worst = 0;
    for (let i = 3; i < rgba.length; i += 4) worst = Math.max(worst, Math.abs(d5[i] - rgba[i]));
    assert.ok(worst <= 4, 'worst alpha error ' + worst);

    const fa = templateAs(ytd.FMT.A8R8G8B8, 4096, 1);
    ytd.resizeTexture(fa, 0, w, h, rgba, { backup: false });
    const ba = ytd.readYtd(fa), ta = ba.textures[0];
    assert.deepEqual([ta.formatName, ta.stride, ta.mips], ['A8R8G8B8', 1024, 1]);
    assert.ok(Buffer.from(ytd.decodeTexture(ba).rgba).equals(rgba), 'uncompressed is lossless');
    assert.equal(ba.rsc.gfxSize, 0x40000, '256 x 256 x 4 bytes = 256 KiB');
  });

  it('refuses sizes the game cannot use, and pixel data of the wrong size, and leaves the file exactly as it was', () => {
    const f = copyTemplate();
    const before = fs.readFileSync(f);
    for (const [w, h] of [[100, 100], [3, 4], [2, 2], [1024, 1000], [0, 0], [1.5, 2], [8192, 8192], [4096, 8192], [-1024, 1024]]) {
      assert.throws(() => ytd.resizeTexture(f, 0, w, h, Buffer.alloc(16)), /power of two wide and high, from 4 to 4096/, `${w}x${h}`);
    }
    assert.throws(() => ytd.resizeTexture(f, 0, 2048, 2048, Buffer.alloc(16)), /pixel data is 4 px, new size is 2048x2048/);
    assert.throws(() => ytd.resizeTexture(f, 1, 2048, 2048, pattern(2048, 2048)), /single texture/);
    assert.ok(fs.readFileSync(f).equals(before));
    assert.equal(fs.existsSync(f + '.bak'), false);
    assert.equal(fs.existsSync(f + '.tmp'), false);
  });

  it('mipsForSize keeps the number of levels a file leaves out', () => {
    const t = (width, height, mips) => ({ width, height, mips });
    assert.equal(ytd.mipsForSize(t(1024, 1024, 9), 2048, 2048), 10, 'the template stops at 4 x 4');
    assert.equal(ytd.mipsForSize(t(1024, 1024, 9), 4096, 4096), 11);
    assert.equal(ytd.mipsForSize(t(1024, 1024, 9), 512, 512), 8);
    assert.equal(ytd.mipsForSize(t(1024, 1024, 11), 2048, 2048), 12, 'a full chain stays a full chain');
    assert.equal(ytd.mipsForSize(t(1024, 1024, 1), 2048, 2048), 1, 'a texture without mips stays without');
    assert.equal(ytd.mipsForSize(t(1024, 1024, 9), 4, 4), 1);
  });

  it('pageFlagsFor picks the smallest single page, and the flags decode to exactly that size', () => {
    const old = 0xd0020007;
    assert.deepEqual(ytd.pageFlagsFor(699048, old), { size: 0x100000, flags: old }, 'the template\'s own pixels get the template\'s own flags');
    assert.equal(ytd.pageFlagsFor(1, old).size, 0x2000);
    assert.equal(ytd.pageFlagsFor(0x2000, old).size, 0x2000);
    assert.equal(ytd.pageFlagsFor(0x2001, old).size, 0x4000);
    assert.equal(ytd.pageFlagsFor(11184808, old).size, 0x1000000);
    assert.equal(ytd.pageFlagsFor(2796200, 0x30020004).flags >>> 28, 3, 'the version bits come from the old flags');
    for (let bytes = 1; bytes < 0x10000000; bytes = Math.ceil(bytes * 1.7)) {
      const p = ytd.pageFlagsFor(bytes, old);
      assert.equal(flagsToSize(p.flags), p.size, 'bytes ' + bytes);
      assert.ok(p.size >= bytes && p.size < Math.max(bytes * 2, 0x4000), 'smallest page for ' + bytes);
    }
    assert.throws(() => ytd.pageFlagsFor(0x10000001, old), /too large for one page/);
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
