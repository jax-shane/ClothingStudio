'use strict';
// Covers src/lib/bc7.js - BC7 texture blocks: decoding all eight block modes (and the reserved one) exactly as a graphics
// card's own BC7 decoder does, and the encoder (mode 6, mode 5 where alpha needs its own line): flat colours come back
// exactly, opaque pixels stay opaque and transparent ones transparent, it beats DXT5 on pictures, and sizes that are not a
// multiple of 4 work.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const bc7 = require('../src/lib/bc7');
const ytd = require('../src/lib/ytd');

// Random blocks, two of every mode (mode 8: no mode bit, reserved), and the 4 x 4 RGBA pixels a graphics card decoded them to
// through Direct3D 11 (WebGL2 with EXT_texture_compression_bptc in Electron). In that run 622,592 random blocks of all modes
// and the encoder's own output decoded exactly alike on the card and in bc7.decode.
const FROM_GPU = [
  ['e121c76f5f8600524578ce7b84121e29', 'dcc61dff2bf687ff6a286dff6a286dff97d946ff70e35eff9421a5ff782680ffdcc61dffdf4140ffac2488ff313121ffef4a29ffdf4140ff9c1ba0ffef4a29ff'],
  ['230937423d033362080a2cd819a04ebc', '88ae10ff88ae10ff94a510ff995c38ff4ede10ff88ae10ff995c38ff849431ff108400ff159234ff926f36ffb51042ff159234ff108400ff189c5affa7353dff'],
  ['86dc4fad9c4221f01f62109839abc66e', '7070c1ff8466c9ff7070c1ffe932f5ff863470ff5d4980ffad2060ff863470ffd53cecff985cd2ffd53cecff8466c9ffa02765ffa02765ff932e6aff5d4980ff'],
  ['627ebc60ac7c4f8bcdd4eb56358737b7', 'ecba5fffcec8c3ff35cb49ff44a278ffd6c4aaffecba5fffd6c4aaff35cb49ffc7cbdbfffbb32effcec8c3ff44a278ffe5bd77ffcec8c3ffd6c4aaffd6c4aaff'],
  ['0464e487efd96e08479b9a3c431ff031', '949cd6ff949cd6ffae828dffae828dff8c6b31ff8c6b31ffe7bdadffe7bdadff949cd6ffe12994ffde3963ff39084affe708f7ffe12994ffe418c6ffe708f7ff'],
  ['c48609aa343809d0a80370b04744e25e', '1884efff082100ff3fa5d6ff29d6c6ff29944eff082100ff29d6c6ff3fa5d6ff29944eff1884efff3a0b26ff520039ff29944eff319c00ff208ca1ff208ca1ff'],
  ['683fd5d53060c5c6d592a710d016840c', '9e006affba9246ffaad84effd45692ffc23a85ffb01c77ffb2b64affaad84effaad84effb01c77ff9e006affba9246ffaad84effc27042ff9e006aff9e006aff'],
  ['b8589b23eafd66435b2a74a1f3c5a48d', 'acee2cffa1992bff9b6f2bff9b6f2bffa1992bffacee2cffa1992bffa6c42cffa1992bffacee2cffa6c42cffa9d185ffa1992bff678ec8ff476de9ff678ec8ff'],
  ['307dbc3793dd56c3b2b62998e90cd5cb', 'db7b81a8c07b655fdb7b655fc67b655fd67b81a8cb7b9cefd17b655fb67b81a8c67b81a8d67b655fc67b81a8d17b81a8c07b4a18b67b655fd17b81a8bb7b4a18'],
  ['b0c26655bf25b63f6059274f7e3930e4', '699ad0567a86dc6f6986dc6f8a52ffb58a86dc6f8a86dc6f6952ffb5599ad05659bdb9275952ffb58acead107acead10599ad0568acead107abdb9277a52ffb5'],
  ['e0faaa4cb6ec130b7cd2cf9a1eccf4f6', 'dd6484b8ab6402fbab6484fbf564c497dd64c4b8c36402dac364c4daab6402fbab64c4fbdd6484b8c36402dadd6402b8dd6442b8ab6484fbf5640297dd6402b8'],
  ['60c2d3ad29a03418f1b65991b1c45ac7', '0d6e04850d8c1c60469b284e337d10730d9b284e208c1c600d7d1073469b284e336e0485339b284e208c1c60208c1c60466e0485208c1c600d6e0485469b284e'],
  ['c03efe541ae15b8aba660187c4331f5a', 'f74d7e44f34bc327f74d8c3ef74d8c3efa4f5257fb4f475bf64d963af54ca135f84e7448f24bce22f94e694df94e694df04af014fa4f5257f44cb92bf74d7e44'],
  ['4064fb661b52bdfcb87a51974ee06c9c', 'a46e90cdc76d9fe8c26d9de5b36e96d9966f89c1a96e92d0b36e96d9bc6d9be0d56ca6f4a46e90cd916f87bdd56ca6f4cb6da1ecaf6e94d5cb6da1ecbc6d9be0'],
  ['8091294021a13ea7a095048bb184c8ce', '3041e32838c548471d8b256738c548473041e3282f32cf343041e32838c548473041e3282d23ba413041e3282c14a64d2d23ba412c14a64d3041e3282c14a64d'],
  ['806d4a4582b0e3fe434d5b2868cea957', '4900db9a4903e6a2928a51a228db1828928a51a24bc02b504905f1aa4908fbb228db18284bc02b504903e6a24908fbb24908fbb24905f1aa6fa53e7a28db1828'],
  ['0049a996bc34ba549a44e92293a39bb0', '0'.repeat(128)],
  ['00e83f9c75222eaba19c22fb113b29eb', '0'.repeat(128)],
];

/** w x h RGBA from a function (x, y) -> [r, g, b, a] */
function picture(w, h, f) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(f(x, y), (y * w + x) * 4);
  return px;
}
const roundTrip = (px, w, h) => bc7.decode(bc7.encode(px, w, h), 0, w, h);
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.length; i++) e += Math.abs(a[i] - b[i]); return e / a.length; };

describe('BC7 decoding', () => {
  it('decodes blocks of every mode exactly as a graphics card does', () => {
    for (const [block, pixels] of FROM_GPU) {
      const mode = block.startsWith('00') ? 8 : Math.log2(parseInt(block.slice(0, 2), 16) & -parseInt(block.slice(0, 2), 16));
      assert.equal(Buffer.from(bc7.decode(Buffer.from(block, 'hex'), 0, 4, 4)).toString('hex'), pixels, `mode ${mode} block ${block}`);
    }
    const modes = new Set(FROM_GPU.map(([b]) => (b.startsWith('00') ? 8 : Math.log2(parseInt(b.slice(0, 2), 16) & -parseInt(b.slice(0, 2), 16)))));
    assert.deepEqual([...modes].sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'the samples cover every mode');
  });

  it('reads blocks at an offset, in order, and cuts edge blocks to the image size', () => {
    const [b0, p0] = FROM_GPU[0], [b1, p1] = FROM_GPU[2];
    const buf = Buffer.concat([Buffer.from('deadbeef', 'hex'), Buffer.from(b0, 'hex'), Buffer.from(b1, 'hex')]);
    const two = bc7.decode(buf, 4, 8, 4);                                        // two blocks side by side
    const rowOf = (hex, r) => hex.slice(r * 32, r * 32 + 32);
    for (let r = 0; r < 4; r++) assert.equal(Buffer.from(two.subarray(r * 32, r * 32 + 32)).toString('hex'), rowOf(p0, r) + rowOf(p1, r));
    const small = bc7.decode(Buffer.from(b0, 'hex'), 0, 2, 2);                   // a 2 x 2 mip: the top left of the block
    assert.equal(Buffer.from(small).toString('hex'), p0.slice(0, 16) + p0.slice(32, 48));
  });
});

describe('BC7 encoding', () => {
  it('a block of one colour comes back exactly (only a 0 or 255 next to an alpha of 255 or 0 can be 1 off)', () => {
    for (let v = 0; v < 256; v++) {
      for (const a of [0, 1, 128, 254, 255]) {
        const colour = [v, 255 - v, (v * 37) & 255, a];
        const back = roundTrip(picture(4, 4, () => colour), 4, 4);
        for (let i = 0; i < 64; i++) {
          const want = colour[i & 3], got = back[i];
          if (got === want) continue;
          assert.ok(Math.abs(got - want) === 1 && (want === 0 || want === 255) && (i & 3) !== 3, `colour ${colour} channel ${i & 3}: ${got}`);
        }
        assert.equal(back[3], a, 'alpha is always exact');
      }
    }
  });

  it('opaque pixels stay fully opaque and transparent ones fully transparent, also at hard edges', () => {
    const w = 64, h = 64;
    const pictures = {
      disc: picture(w, h, (x, y) => ((x - 30) ** 2 + (y - 30) ** 2 < 400 ? [250, 250, 10, 255] : [0, 0, 0, 0])),
      fade: picture(w, h, (x, y) => [x * 4, 255 - y * 4, 90, x < 18 ? 255 : x < 38 ? x * 6 : 0]),
      // a colourful logo on a transparent background with a few half-transparent dots: one RGBA line cannot hold all of it
      logo: picture(w, h, (x, y) => ((x - 30) ** 2 + (y - 30) ** 2 < 600 ? [(x * 9) & 255, (y * 5) & 255, ((x + y) * 3) & 255, 255] : (x + y) % 7 ? [0, 0, 0, 0] : [40, 40, 40, 128])),
      lace: picture(w, h, (x, y) => ((((x >> 1) + (y >> 1)) % 3) ? [200 + (x & 31), 180 - (y & 63), 160, 255] : [0, 0, 0, 0])),
    };
    for (const [name, px] of Object.entries(pictures)) {
      const back = roundTrip(px, w, h);
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] === 255) assert.equal(back[i], 255, `${name}: opaque pixel ${i >> 2}`);
        if (px[i] === 0) assert.equal(back[i], 0, `${name}: transparent pixel ${i >> 2}`);
      }
    }
    const modes = new Set();
    const enc = bc7.encode(pictures.logo, w, h);
    for (let o = 0; o < enc.length; o += 16) modes.add(Math.log2(enc[o] & -enc[o]));
    assert.deepEqual([...modes].sort(), [5, 6], 'blocks whose alpha needs a line of its own are written as mode 5');
  });

  it('keeps pictures better than DXT5 does', () => {
    const w = 128, h = 128;
    const pictures = {
      gradient: picture(w, h, (x, y) => [x * 2, y * 2, (x + y) & 255, 255]),
      stripes: picture(w, h, (x, y) => (((x + y) >> 3) & 1 ? [200, 30, 30, 255] : [30, 30, 200, 255])),
      'alpha ramp': picture(w, h, (x) => [10, 200, 90, x * 2]),
      shading: picture(w, h, (x, y) => { const v = 128 + 60 * Math.sin(x / 7) * Math.cos(y / 11); return [v, v * 0.8, v * 0.6 + x / 8, 255]; }),
    };
    for (const [name, px] of Object.entries(pictures)) {
      const e7 = meanError(px, roundTrip(px, w, h));
      const e5 = meanError(px, ytd.decodeLevel(ytd.buildChain(px, w, h, ytd.FMT.DXT5, 1), 0, ytd.FMT.DXT5, w, h, 0));
      assert.ok(e7 < 1, `${name}: mean error ${e7}`);
      assert.ok(e7 < e5, `${name}: BC7 ${e7} vs DXT5 ${e5}`);
    }
  });

  it('writes one 16-byte block per 4 x 4 pixels (mode 6 for opaque ones), including sizes that are not a multiple of 4', () => {
    for (const [w, h] of [[4, 4], [8, 4], [1, 1], [2, 2], [6, 10], [64, 16]]) {
      const px = picture(w, h, (x, y) => [x * 40, y * 20, 128, 255]);
      const enc = bc7.encode(px, w, h);
      assert.equal(enc.length, ytd.levelSize(ytd.FMT.BC7, w, h), `${w}x${h}`);
      for (let o = 0; o < enc.length; o += 16) assert.equal(enc[o] & 0x7f, 0x40, 'mode 6 at block ' + o / 16);
      assert.equal(bc7.decode(enc, 0, w, h).length, w * h * 4);
    }
    const one = picture(1, 1, () => [12, 34, 56, 255]);
    assert.deepEqual([...roundTrip(one, 1, 1)], [12, 34, 56, 255]);
  });
});
