'use strict';
// Covers renderer/js/fabric.js - the maps of the "Fabric look" dialog: the folds and creases taken from a texture, the fabric
// grains, and bending a print along the folds. Loaded like texsize.js: the file is an ES module without imports, so its
// `export` keywords are dropped and the source is evaluated.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'fabric.js'), 'utf8');
const EXPORTS = [...SOURCE.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
let F;
before(() => { F = new Function(SOURCE.replace(/^export /gm, '') + `\nreturn { ${EXPORTS.join(', ')} };`)(); });

/** w x h RGBA from (x, y) -> [r, g, b, a] */
function picture(w, h, f) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(f(x, y), (y * w + x) * 4);
  return px;
}
const grey = (map, w, x, y) => map[(y * w + x) * 4];
const stats = (map) => {
  let s = 0, s2 = 0;
  const n = map.length / 4;
  for (let i = 0; i < map.length; i += 4) { s += map[i]; s2 += map[i] * map[i]; }
  return { mean: s / n, sd: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) };
};
const isGreyOpaque = (map) => { for (let i = 0; i < map.length; i += 4) if (map[i] !== map[i + 1] || map[i] !== map[i + 2] || map[i + 3] !== 255) return false; return true; };

describe('the module can be loaded without a browser', () => {
  it('has no imports, and every export is a plain const or function', () => {
    assert.equal(/^import\s/m.test(SOURCE), false, 'fabric.js must stay free of imports');
    assert.equal((SOURCE.match(/^export /gm) || []).length, EXPORTS.length);
    assert.deepEqual([...EXPORTS].sort(), ['GRAINS', 'bend', 'blur', 'foldsMap', 'grainMap', 'luminance']);
  });
});

describe('blur', () => {
  it('leaves an even picture as it is, spreads a dot, and radius 0 copies', () => {
    const w = 32, h = 16;
    const flat = new Float32Array(w * h).fill(77);
    assert.ok(F.blur(flat, w, h, 3).every((v) => Math.abs(v - 77) < 1e-3));
    const dot = new Float32Array(w * h); dot[8 * w + 16] = 1000;
    const b = F.blur(dot, w, h, 2);
    assert.ok(b[8 * w + 16] < 200 && b[8 * w + 17] > 0 && b[9 * w + 16] > 0, 'the dot spreads to its neighbours');
    let total = 0; for (const v of b) total += v;
    assert.ok(Math.abs(total - 1000) < 1, 'nothing is lost away from the edges: ' + total);
    assert.deepEqual(Array.from(F.blur(dot, w, h, 0)), Array.from(dot));
  });
});

describe('folds and creases from a texture', () => {
  const w = 128, h = 128, size = 6;
  const onCrease = (x, y) => Math.abs(x - y) <= 1;                                   // a diagonal crease
  const shirt = (base, depth) => picture(w, h, (x, y) => (onCrease(x, y) ? base.map((c) => Math.max(0, c - depth)) : base).concat(255));

  it('a texture of one colour has no folds: plain grey', () => {
    for (const colour of [[200, 30, 30], [0, 0, 0], [255, 255, 255]]) {
      const { rgba, gain } = F.foldsMap(picture(w, h, () => colour.concat(255)), w, h, { size });
      assert.ok(isGreyOpaque(rgba));
      assert.ok(rgba.every((v, i) => (i & 3) === 3 || v === 128), String(colour));
      assert.equal(gain, 0);
    }
  });

  it('a crease comes out dark, the cloth around it stays grey', () => {
    const { rgba } = F.foldsMap(shirt([200, 40, 40], 60), w, h, { size });
    assert.ok(isGreyOpaque(rgba));
    assert.ok(grey(rgba, w, 64, 64) < 60, 'on the crease: ' + grey(rgba, w, 64, 64));
    assert.ok(Math.abs(grey(rgba, w, 100, 20) - 128) <= 2, 'far from it: ' + grey(rgba, w, 100, 20));
  });

  it('the colour of the cloth does not matter, only its shading', () => {
    const red = F.foldsMap(shirt([200, 40, 40], 40), w, h, { size }).rgba;
    const blue = F.foldsMap(shirt([40, 60, 210], 40), w, h, { size }).rgba;
    let diff = 0; for (let i = 0; i < red.length; i += 4) diff += Math.abs(red[i] - blue[i]);
    assert.ok(diff / (w * h) < 3, 'mean difference ' + diff / (w * h));
  });

  it('faint creases are levelled up so they show, within a limit; contrast scales the result', () => {
    const faint = F.foldsMap(shirt([150, 150, 150], 6), w, h, { size });
    assert.ok(grey(faint.rgba, w, 64, 64) < 90, 'a crease only 6 levels deep still shows: ' + grey(faint.rgba, w, 64, 64));
    assert.ok(faint.gain <= 8);
    const half = F.foldsMap(shirt([150, 150, 150], 6), w, h, { size, contrast: 0.5 });
    assert.ok(Math.abs((128 - grey(half.rgba, w, 64, 64)) - (128 - grey(faint.rgba, w, 64, 64)) / 2) <= 1);
  });
});

describe('fabric grains', () => {
  const w = 96, h = 96;

  it('every grain is a grey map around 128 with a visible surface, the same for the same seed', () => {
    for (const kind of F.GRAINS) {
      const { rgba } = F.grainMap(kind, w, h, { size: 3, seed: 5 });
      assert.equal(rgba.length, w * h * 4, kind);
      assert.ok(isGreyOpaque(rgba), kind);
      const s = stats(rgba);
      assert.ok(Math.abs(s.mean - 128) < 8, `${kind}: mean ${s.mean}`);
      assert.ok(s.sd > 12, `${kind}: spread ${s.sd}`);
      assert.deepEqual(F.grainMap(kind, w, h, { size: 3, seed: 5 }).rgba, rgba, `${kind} is repeatable`);
      assert.notDeepEqual(F.grainMap(kind, w, h, { size: 3, seed: 6 }).rgba, rgba, `${kind} changes with the seed`);
    }
    assert.throws(() => F.grainMap('silk', w, h), /unknown fabric grain: silk/);
  });

  it('a bigger grain size gives bigger threads, stitches and cells (fewer light / dark changes along a row)', () => {
    const changes = (map) => {
      let n = 0;
      for (let y = 0; y < h; y += 3) for (let x = 1; x < w; x++) if ((grey(map, w, x, y) >= 128) !== (grey(map, w, x - 1, y) >= 128)) n++;
      return n;
    };
    for (const kind of F.GRAINS) {
      const fine = changes(F.grainMap(kind, w, h, { size: 4 }).rgba), coarse = changes(F.grainMap(kind, w, h, { size: 12 }).rgba);
      assert.ok(coarse < fine, `${kind}: ${coarse} changes at size 12, ${fine} at size 4`);
    }
  });
});

describe('bending a print along the folds', () => {
  const w = 80, h = 40;
  const line = picture(w, h, (x) => (x === 50 ? [255, 255, 255, 255] : [0, 0, 0, 0]));    // a vertical white line, the rest see-through
  const flatMap = picture(w, h, () => [128, 128, 128, 255]);
  const stepMap = picture(w, h, (x) => (x < 30 ? [128, 128, 128, 255] : [192, 192, 192, 255]));   // right part: half way to white

  it('nothing moves with amount 0 or a plain grey map', () => {
    assert.deepEqual(F.bend(line, w, h, stepMap, 0), line);
    assert.deepEqual(F.bend(line, w, h, flatMap, 12), line);
  });

  it('a lighter map moves the print by that share of the amount, diagonally', () => {
    const out = F.bend(line, w, h, stepMap, 8);                                       // (192 - 128) / 128 = 0.5 -> 4 px
    for (const y of [10, 20, 30]) {
      const lit = [];
      for (let x = 0; x < w; x++) if (out[(y * w + x) * 4 + 3] > 128) lit.push(x);
      assert.deepEqual(lit, [54], 'row ' + y);
    }
  });

  it('see-through stays see-through and colours keep their tint at soft edges (no dark rims)', () => {
    const blob = picture(w, h, (x, y) => { const d = Math.hypot(x - 40, y - 20); return d < 10 ? [230, 20, 20, 255] : d < 14 ? [230, 20, 20, Math.round(255 * (14 - d) / 4)] : [0, 0, 0, 0]; });
    const ramp = picture(w, h, (x) => { const v = Math.round(64 + x * 1.6); return [v, v, v, 255]; });
    const out = F.bend(blob, w, h, ramp, 10);
    let seen = 0;
    for (let i = 0; i < out.length; i += 4) {
      if (!out[i + 3]) continue;
      seen++;
      assert.ok(out[i] >= 225 && out[i + 1] <= 25 && out[i + 2] <= 25, `pixel ${i / 4}: ${[...out.slice(i, i + 4)]}`);
    }
    assert.ok(seen > 200);
    assert.equal(out[(2 * w + 2) * 4 + 3], 0, 'far from the blob stays see-through');
  });
});
