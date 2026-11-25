'use strict';
// Covers renderer/js/texsize.js - which texture sizes the "this image is bigger than the texture" questions offer.
// The file is an ES module (the page imports it) with no imports of its own, so for the tests its `export` keywords are
// dropped and the source is evaluated: that works on every Node version the project supports (20 and up), with no
// module-type switches. The first test guards that assumption.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ytd = require('../src/lib/ytd');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'texsize.js'), 'utf8');
const EXPORTS = [...SOURCE.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
let T;
before(() => { T = new Function(SOURCE.replace(/^export /gm, '') + `\nreturn { ${EXPORTS.join(', ')} };`)(); });

describe('the module can be loaded without a browser', () => {
  it('has no imports, and every export is a plain const or function', () => {
    assert.equal(/^import\s/m.test(SOURCE), false, 'texsize.js must stay free of imports');
    assert.equal((SOURCE.match(/^export /gm) || []).length, EXPORTS.length, 'an export that is not `export const` / `export function` would not be loaded by this test');
    assert.deepEqual([...EXPORTS].sort(), ['MAX_SIDE', 'addChoices', 'growSizes', 'mbText', 'memoryMB', 'textureSizeFor']);
  });
});

const sides = (list) => list.map((s) => [s.w, s.h]);

describe('the biggest size the page offers is the biggest size the writer accepts', () => {
  it('MAX_SIDE equals ytd.MAX_RESIZE', () => assert.equal(T.MAX_SIDE, ytd.MAX_RESIZE));
});

describe('growSizes: what a layer import offers', () => {
  it('a 4096 image on a 1024 texture: 2048 or 4096', () => assert.deepEqual(sides(T.growSizes(1024, 1024, 4096, 4096)), [[2048, 2048], [4096, 4096]]));
  it('a 2048 image: just 2048 (nothing bigger is needed)', () => assert.deepEqual(sides(T.growSizes(1024, 1024, 2048, 2048)), [[2048, 2048]]));
  it('an image in between (3000): 2048 or 4096, the first size that holds all of it ends the list', () => {
    assert.deepEqual(sides(T.growSizes(1024, 1024, 3000, 3000)), [[2048, 2048], [4096, 4096]]);
    assert.deepEqual(sides(T.growSizes(1024, 1024, 2100, 2100)), [[2048, 2048], [4096, 4096]]);
  });
  it('a huge image is capped at 4096', () => assert.deepEqual(sides(T.growSizes(1024, 1024, 9000, 9000)), [[2048, 2048], [4096, 4096]]));
  it('a texture that is already 4096 has nothing to grow into', () => assert.deepEqual(T.growSizes(4096, 4096, 8192, 8192), []));
  it('a 2048 texture and a 4096 image: 4096', () => assert.deepEqual(sides(T.growSizes(2048, 2048, 4096, 4096)), [[4096, 4096]]));
  it('only an image bigger in BOTH directions asks (a wide banner or a logo that is merely large just gets fitted)', () => {
    assert.deepEqual(T.growSizes(1024, 1024, 2000, 500), []);
    assert.deepEqual(T.growSizes(1024, 1024, 1024, 4096), []);
    assert.deepEqual(T.growSizes(1024, 1024, 1024, 1024), []);
    assert.deepEqual(T.growSizes(1024, 1024, 512, 512), []);
    assert.deepEqual(T.growSizes(1024, 1024, 1025, 1025).length, 1);
  });
  it('a non-square texture keeps its shape', () => assert.deepEqual(sides(T.growSizes(1024, 512, 4096, 4096)), [[2048, 1024], [4096, 2048]]));
  it('every offered size is a power of two the writer accepts', () => {
    for (const [w, h, iw, ih] of [[1024, 1024, 5000, 5000], [512, 512, 4096, 4096], [256, 128, 3000, 3000], [2048, 1024, 9000, 9000]]) {
      for (const s of T.growSizes(w, h, iw, ih)) {
        for (const v of [s.w, s.h]) assert.ok(v >= 4 && v <= ytd.MAX_RESIZE && (v & (v - 1)) === 0, `${w}x${h} -> ${s.w}x${s.h}`);
      }
    }
  });
});

describe('textureSizeFor: the size a picked image gets in the Add flows', () => {
  it('cap 0 keeps the pack size', () => assert.deepEqual(T.textureSizeFor(1024, 1024, 4096, 4096, 0), { w: 1024, h: 1024, resize: false }));
  it('cap 4096: a 4096 image gets 4096, a 2048 image 2048, a 3000 image 4096 (nothing is cut off), a 2100 image 4096', () => {
    assert.deepEqual(T.textureSizeFor(1024, 1024, 4096, 4096, 4096), { w: 4096, h: 4096, resize: true });
    assert.deepEqual(T.textureSizeFor(1024, 1024, 2048, 2048, 4096), { w: 2048, h: 2048, resize: true });
    assert.deepEqual(T.textureSizeFor(1024, 1024, 3000, 3000, 4096), { w: 4096, h: 4096, resize: true });
    assert.deepEqual(T.textureSizeFor(1024, 1024, 2100, 2100, 4096), { w: 4096, h: 4096, resize: true });
  });
  it('cap 2048 stops a 4096 image at 2048', () => assert.deepEqual(T.textureSizeFor(1024, 1024, 4096, 4096, 2048), { w: 2048, h: 2048, resize: true }));
  it('an image that is not bigger than the template never changes the size', () => {
    assert.equal(T.textureSizeFor(1024, 1024, 1024, 1024, 4096).resize, false);
    assert.equal(T.textureSizeFor(1024, 1024, 800, 800, 4096).resize, false);
    assert.equal(T.textureSizeFor(1024, 1024, 4096, 512, 4096).resize, false);
  });
  it('the cap can be above the template-and-image limit but never past 4096; a cap below the template changes nothing', () => {
    assert.equal(T.textureSizeFor(1024, 1024, 9000, 9000, 99999).w, 4096);
    assert.equal(T.textureSizeFor(2048, 2048, 4096, 4096, 1024).resize, false);
  });
  it('a pack whose textures are already 2048 grows to 4096 only', () => assert.deepEqual(T.textureSizeFor(2048, 2048, 4096, 4096, 4096), { w: 4096, h: 4096, resize: true }));
  it('non-square templates keep their shape', () => assert.deepEqual(T.textureSizeFor(1024, 512, 4096, 4096, 4096), { w: 4096, h: 2048, resize: true }));
});

describe('addChoices: the one question for all images of an "Add" action', () => {
  const item = (name, w, h, tplW = 1024, tplH = 1024) => ({ name, w, h, tplW, tplH });
  it('nothing bigger than the template: no question', () => assert.equal(T.addChoices([item('a.png', 1024, 1024), item('b.png', 512, 512)]), null));
  it('lists the images that are bigger and the sizes that can be allowed', () => {
    const q = T.addChoices([item('a.png', 4096, 4096), item('b.png', 2048, 2048), item('c.png', 800, 800)]);
    assert.deepEqual(q.bigger.map((i) => i.name), ['a.png', 'b.png']);
    assert.deepEqual(q.caps, [2048, 4096]);
  });
  it('one 2048 image: only 2048 can be allowed', () => assert.deepEqual(T.addChoices([item('a.png', 2048, 2048)]).caps, [2048]));
  it('images for different templates (a 2048 pack and a 1024 pack) are all considered', () => {
    const q = T.addChoices([item('a.png', 4096, 4096, 2048, 2048), item('b.png', 2048, 2048, 1024, 1024)]);
    assert.deepEqual(q.caps, [2048, 4096]);
  });
  it('an image for a template that is already 4096 does not count', () => assert.equal(T.addChoices([item('a.png', 8192, 8192, 4096, 4096)]), null));
});

describe('memory estimate', () => {
  it('matches the sizes quoted in the dialogs', () => {
    assert.equal(T.mbText(T.memoryMB(1024, 1024, 'DXT1')), '0.7 MB');
    assert.equal(T.mbText(T.memoryMB(2048, 2048, 'DXT1')), '2.7 MB');
    assert.equal(T.mbText(T.memoryMB(4096, 4096, 'DXT1')), '11 MB');
    assert.equal(T.mbText(T.memoryMB(4096, 4096, 'DXT5')), '21 MB');
    assert.equal(T.mbText(T.memoryMB(1024, 1024, 'A8R8G8B8')), '5.3 MB');
  });
});
