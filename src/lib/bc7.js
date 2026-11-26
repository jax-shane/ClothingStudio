'use strict';
// BC7 texture blocks (DXGI_FORMAT_BC7_UNORM; a .ytd stores it as FourCC "BC7 " = 0x20374342). Every 4 x 4 pixels are one
// 16-byte block. decode() reads all eight block modes. encode() writes mode 6, one straight RGBA line per block with 16 steps
// along it (DXT5 has 4 colour steps), or mode 5 where a block's alpha is better kept on a line of its own; fully opaque and
// fully transparent pixels stay exactly so. Bit layout, partition and anchor tables: the Direct3D 11 BC7 format, the same as
// OpenGL's BPTC.

// ------------------------------------------------------------------ tables
// ns: subsets (parts of the block with their own endpoints), pb: partition bits, rb: rotation bits, isb: index-selection bit,
// cb / ab: colour / alpha bits per endpoint, epb: a p-bit per endpoint, spb: a p-bit per subset, ib: index bits,
// ib2: bits of the second index set (modes 4 and 5 index colour and alpha separately)
const MODES = [
  { ns: 3, pb: 4, rb: 0, isb: 0, cb: 4, ab: 0, epb: 1, spb: 0, ib: 3, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 6, ab: 0, epb: 0, spb: 1, ib: 3, ib2: 0 },
  { ns: 3, pb: 6, rb: 0, isb: 0, cb: 5, ab: 0, epb: 0, spb: 0, ib: 2, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 7, ab: 0, epb: 1, spb: 0, ib: 2, ib2: 0 },
  { ns: 1, pb: 0, rb: 2, isb: 1, cb: 5, ab: 6, epb: 0, spb: 0, ib: 2, ib2: 3 },
  { ns: 1, pb: 0, rb: 2, isb: 0, cb: 7, ab: 8, epb: 0, spb: 0, ib: 2, ib2: 2 },
  { ns: 1, pb: 0, rb: 0, isb: 0, cb: 7, ab: 7, epb: 1, spb: 0, ib: 4, ib2: 0 },
  { ns: 2, pb: 6, rb: 0, isb: 0, cb: 5, ab: 5, epb: 1, spb: 0, ib: 2, ib2: 0 },
];

// the subset each of the 16 pixels (row by row) belongs to, for the 64 two-subset and the 64 three-subset partitions
const rows = (list) => Uint8Array.from(list.join(''), Number);
const P2 = rows([
  '0011001100110011', '0001000100010001', '0111011101110111', '0001001100110111', '0000000100010011', '0011011101111111', '0001001101111111', '0000000100110111',
  '0000000000010011', '0011011111111111', '0000000101111111', '0000000000010111', '0001011111111111', '0000000011111111', '0000111111111111', '0000000000001111',
  '0000100011101111', '0111000100000000', '0000000010001110', '0111001100010000', '0011000100000000', '0000100011001110', '0000000010001100', '0111001100110001',
  '0011000100010000', '0000100010001100', '0110011001100110', '0011011001101100', '0001011111101000', '0000111111110000', '0111000110001110', '0011100110011100',
  '0101010101010101', '0000111100001111', '0101101001011010', '0011001111001100', '0011110000111100', '0101010110101010', '0110100101101001', '0101101010100101',
  '0111001111001110', '0001001111001000', '0011001001001100', '0011101111011100', '0110100110010110', '0011110011000011', '0110011010011001', '0000011001100000',
  '0100111001000000', '0010011100100000', '0000001001110010', '0000010011100100', '0110110010010011', '0011011011001001', '0110001110011100', '0011100111000110',
  '0110110011001001', '0110001100111001', '0111111010000001', '0001100011100111', '0000111100110011', '0011001111110000', '0010001011101110', '0100010001110111',
]);
const P3 = rows([
  '0011001102212222', '0001001122112221', '0000200122112211', '0222002200110111', '0000000011221122', '0011001100220022', '0022002211111111', '0011001122112211',
  '0000000011112222', '0000111111112222', '0000111122222222', '0012001200120012', '0112011201120112', '0122012201220122', '0011011211221222', '0011200122002220',
  '0001001101121122', '0111001120012200', '0000112211221122', '0022002200221111', '0111011102220222', '0001000122212221', '0000001101220122', '0000110022102210',
  '0122012200110000', '0012001211222222', '0110122112210110', '0000011012211221', '0022110211020022', '0110011020022222', '0011012201220011', '0000200022112221',
  '0000000211221222', '0222002200120011', '0011001200220222', '0120012001200120', '0000111122220000', '0120120120120120', '0120201212010120', '0011220011220011',
  '0011112222000011', '0101010122222222', '0000000021212121', '0022112200221122', '0022001100220011', '0220122102201221', '0101222222220101', '0000212121212121',
  '0101010101012222', '0222011102220111', '0002111200021112', '0000211221122112', '0222011101110222', '0002111211120002', '0110011001102222', '0000000021122112',
  '0110011022222222', '0022001100110022', '0022112211220022', '0000000000002112', '0002000100020001', '0222122202221222', '0101222222222222', '0111201122012220',
]);
// the pixel of each subset whose index is stored with one bit less (its top bit is 0): pixel 0 for the first subset, these for the others
const A2 = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
];
const A3A = [
  3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
  8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
];
const A3B = [
  15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
  15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
];
// interpolation weights (out of 64) for 2, 3 and 4 index bits
const WEIGHTS = [null, null, [0, 21, 43, 64], [0, 9, 18, 27, 37, 46, 55, 64], [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64]];
const mix = (a, b, w) => ((64 - w) * a + w * b + 32) >> 6;

// ------------------------------------------------------------------ decode
let SRC = null, RBIT = 0;                              // the buffer being read and the position of the next bit in it
/** The next n (at most 8) bits, least significant first. A block's last byte may look one byte further; those bits are masked off. */
function bits(n) {
  const at = RBIT >> 3;
  const v = ((SRC[at] | (SRC[at + 1] << 8)) >> (RBIT & 7)) & ((1 << n) - 1);
  RBIT += n;
  return v;
}

const EP = new Int32Array(24), IX = new Uint8Array(16), IX2 = new Uint8Array(16);
const expand = (v, n) => { v <<= 8 - n; return v | (v >> n); };       // n bits to 8 by repeating the top bits
const addP = (e, p) => { for (let c = 0; c < 4; c++) EP[e * 4 + c] = (EP[e * 4 + c] << 1) | p; };

/** Decode the 16-byte block at src[off] into px (16 pixels row by row, RGBA). */
function decodeBlock(src, off, px) {
  const first = src[off];
  if (!first) { px.fill(0); return; }                  // no mode bit set: a reserved mode, which decodes to transparent black
  let mode = 0;
  while (!(first & (1 << mode))) mode++;
  const m = MODES[mode], ne = m.ns * 2;
  SRC = src; RBIT = off * 8 + mode + 1;
  const partition = bits(m.pb), rotation = bits(m.rb), isel = bits(m.isb);
  for (let c = 0; c < 3; c++) for (let e = 0; e < ne; e++) EP[e * 4 + c] = bits(m.cb);
  for (let e = 0; e < ne; e++) EP[e * 4 + 3] = m.ab ? bits(m.ab) : 0;
  let cb = m.cb, ab = m.ab;
  if (m.epb) for (let e = 0; e < ne; e++) addP(e, bits(1));
  if (m.spb) for (let s = 0; s < m.ns; s++) { const p = bits(1); addP(2 * s, p); addP(2 * s + 1, p); }
  if (m.epb || m.spb) { cb++; if (ab) ab++; }
  for (let e = 0; e < ne; e++) {
    for (let c = 0; c < 3; c++) EP[e * 4 + c] = expand(EP[e * 4 + c], cb);
    EP[e * 4 + 3] = ab ? expand(EP[e * 4 + 3], ab) : 255;
  }

  const table = m.ns === 2 ? P2 : m.ns === 3 ? P3 : null, row = partition * 16;
  const anchor1 = m.ns === 2 ? A2[partition] : m.ns === 3 ? A3A[partition] : -1, anchor2 = m.ns === 3 ? A3B[partition] : -1;
  for (let i = 0; i < 16; i++) IX[i] = bits(i === 0 || i === anchor1 || i === anchor2 ? m.ib - 1 : m.ib);
  if (m.ib2) for (let i = 0; i < 16; i++) IX2[i] = bits(i === 0 ? m.ib2 - 1 : m.ib2);

  for (let i = 0; i < 16; i++) {
    const e0 = (table ? table[row + i] : 0) * 8, e1 = e0 + 4;
    let ci = IX[i], ai = IX[i], cw = WEIGHTS[m.ib], aw = cw;
    if (m.ib2) {                                       // modes 4 and 5: the index-selection bit says which set is colour, which alpha
      if (isel) { ci = IX2[i]; cw = WEIGHTS[m.ib2]; } else { ai = IX2[i]; aw = WEIGHTS[m.ib2]; }
    }
    let r = mix(EP[e0], EP[e1], cw[ci]), g = mix(EP[e0 + 1], EP[e1 + 1], cw[ci]), b = mix(EP[e0 + 2], EP[e1 + 2], cw[ci]);
    let a = mix(EP[e0 + 3], EP[e1 + 3], aw[ai]);
    if (rotation === 1) { const t = r; r = a; a = t; } else if (rotation === 2) { const t = g; g = a; a = t; } else if (rotation === 3) { const t = b; b = a; a = t; }
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = a;
  }
}

/** Decode a w x h BC7 image starting at buf[off] to RGBA. */
function decode(buf, off, w, h) {
  const out = new Uint8Array(w * h * 4), px = new Uint8Array(64);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  let pos = off;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, pos += 16) {
      decodeBlock(buf, pos, px);
      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= h) break;
        for (let pxn = 0; pxn < 4; pxn++) {
          const x = bx * 4 + pxn;
          if (x >= w) break;
          const o = (y * w + x) * 4, s = (py * 4 + pxn) * 4;
          out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; out[o + 3] = px[s + 3];
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ encode (modes 6 and 5)
// Mode 6 puts colour and alpha on one RGBA line with 16 steps: the closest fit for opaque pixels and for smooth alpha. A block
// whose alpha varies can also be written as mode 5, which gives alpha a line of its own (exact 8-bit ends, 4 steps) beside a
// colour line with 4 steps, the way DXT5 keeps alpha apart. Such a block gets whichever mode keeps more of its fully opaque and
// fully transparent pixels exactly so, and then whichever decodes closer.
const W2 = WEIGHTS[2], W4 = WEIGHTS[4];
const NEAREST = new Uint8Array(65);                    // a position 0..64 along the line -> the nearest of the 16 steps
for (let t = 0; t <= 64; t++) { let k = 0; for (let j = 1; j < 16; j++) if (Math.abs(W4[j] - t) < Math.abs(W4[k] - t)) k = j; NEAREST[t] = k; }

const E = new Float64Array(8);                         // the two endpoints, RGBA, before quantizing
const Q = new Int32Array(8), QB = new Int32Array(8);   // mode 6: quantized endpoints as 8-bit values (the low bit is the p-bit): current, best
const P = new Int32Array(2), PB = new Int32Array(2);   // their p-bits
const IXC = new Uint8Array(16), IXB = new Uint8Array(16);
const CQ = new Int32Array(6), CQB = new Int32Array(6); // mode 5: colour endpoints with 7 bits per channel: current, best
const CI = new Uint8Array(16), CIB = new Uint8Array(16), AI = new Uint8Array(16), ALPHA = new Int32Array(2);
const PAL = new Int32Array(64), SUMS = new Float64Array(8);
const clamp255 = (x) => (x < 0 ? 0 : x > 255 ? 255 : x);
const q7 = (x, p) => { const v = Math.round((x - p) / 2); return ((v < 0 ? 0 : v > 127 ? 127 : v) << 1) | p; };
const q7n = (x) => { const v = Math.round(x * 127 / 255); return v < 0 ? 0 : v > 127 ? 127 : v; };
const x7 = (v) => (v << 1) | (v >> 6);                 // 7 bits -> 8, as the decoder expands them

/** Endpoints along the main direction the 16 pixels spread in (principal axis, by power iteration), into E; alpha only counts with useAlpha. */
function principal(px, useAlpha) {
  let mr = 0, mg = 0, mb = 0, ma = 0;
  for (let i = 0; i < 64; i += 4) { mr += px[i]; mg += px[i + 1]; mb += px[i + 2]; ma += px[i + 3]; }
  mr /= 16; mg /= 16; mb /= 16; ma /= 16;
  let rr = 0, rg = 0, rb = 0, ra = 0, gg = 0, gb = 0, ga = 0, bb = 0, ba = 0, aa = 0;
  for (let i = 0; i < 64; i += 4) {
    const r = px[i] - mr, g = px[i + 1] - mg, b = px[i + 2] - mb, a = useAlpha ? px[i + 3] - ma : 0;
    rr += r * r; rg += r * g; rb += r * b; ra += r * a; gg += g * g; gb += g * b; ga += g * a; bb += b * b; ba += b * a; aa += a * a;
  }
  const most = Math.max(rr, gg, bb, aa);               // start from the covariance column of the channel that varies most
  let vr = ra, vg = ga, vb = ba, va = aa;
  if (most === rr) { vr = rr; vg = rg; vb = rb; va = ra; } else if (most === gg) { vr = rg; vg = gg; vb = gb; va = ga; } else if (most === bb) { vr = rb; vg = gb; vb = bb; va = ba; }
  for (let it = 0; it < 8; it++) {
    const nr = rr * vr + rg * vg + rb * vb + ra * va, ng = rg * vr + gg * vg + gb * vb + ga * va;
    const nb = rb * vr + gb * vg + bb * vb + ba * va, na = ra * vr + ga * vg + ba * vb + aa * va;
    const len = Math.sqrt(nr * nr + ng * ng + nb * nb + na * na);
    if (len < 1e-9) break;
    vr = nr / len; vg = ng / len; vb = nb / len; va = na / len;
  }
  const len = Math.sqrt(vr * vr + vg * vg + vb * vb + va * va) || 1;
  vr /= len; vg /= len; vb /= len; va /= len;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 64; i += 4) {
    const t = (px[i] - mr) * vr + (px[i + 1] - mg) * vg + (px[i + 2] - mb) * vb + (useAlpha ? (px[i + 3] - ma) * va : 0);
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  E[0] = clamp255(mr + lo * vr); E[1] = clamp255(mg + lo * vg); E[2] = clamp255(mb + lo * vb); E[3] = clamp255(ma + lo * va);
  E[4] = clamp255(mr + hi * vr); E[5] = clamp255(mg + hi * vg); E[6] = clamp255(mb + hi * vb); E[7] = clamp255(ma + hi * va);
}

/**
 * E -> Q / P: 7 bits per channel plus a low bit (p-bit) shared by the channels of an endpoint, chosen to fit best. Alpha 255
 * needs p-bit 1 and alpha 0 needs p-bit 0, so an endpoint at (or right next to) the alpha of the block's fully opaque or fully
 * transparent pixels gets exactly that alpha: opaque stays opaque and invisible stays invisible.
 */
function quantize(full, zero) {
  for (let e = 0; e < 2; e++) {
    const a = E[e * 4 + 3];
    let best = 1;
    if (full && a >= 250) { E[e * 4 + 3] = 255; best = 1; }
    else if (zero && a <= 5) { E[e * 4 + 3] = 0; best = 0; }
    else {
      let bestErr = Infinity;
      for (let p = 0; p <= 1; p++) {
        let err = 0;
        for (let c = 0; c < 4; c++) { const d = q7(E[e * 4 + c], p) - E[e * 4 + c]; err += d * d; }
        if (err < bestErr) { bestErr = err; best = p; }
      }
    }
    P[e] = best;
    for (let c = 0; c < 4; c++) Q[e * 4 + c] = q7(E[e * 4 + c], best);
  }
}

/** The best of the 16 steps between the endpoints Q for every pixel, into IXC; answers the summed squared error. */
function fitIndices(px) {
  for (let k = 0; k < 16; k++) for (let c = 0; c < 4; c++) PAL[k * 4 + c] = mix(Q[c], Q[4 + c], W4[k]);
  const d0 = Q[4] - Q[0], d1 = Q[5] - Q[1], d2 = Q[6] - Q[2], d3 = Q[7] - Q[3];
  const dd = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
  let total = 0;
  for (let i = 0; i < 16; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2], a = px[i * 4 + 3];
    let k = 0;
    if (dd) {                                          // project onto the line, then check the steps either side (rounding)
      const t = Math.round(((r - Q[0]) * d0 + (g - Q[1]) * d1 + (b - Q[2]) * d2 + (a - Q[3]) * d3) * 64 / dd);
      k = NEAREST[t < 0 ? 0 : t > 64 ? 64 : t];
    }
    let best = 0, bestErr = Infinity;
    for (let j = k > 0 ? k - 1 : 0, end = k < 15 ? k + 1 : 15; j <= end; j++) {
      const er = PAL[j * 4] - r, eg = PAL[j * 4 + 1] - g, eb = PAL[j * 4 + 2] - b, ea = PAL[j * 4 + 3] - a;
      const err = er * er + eg * eg + eb * eb + ea * ea;
      if (err < bestErr) { bestErr = err; best = j; }
    }
    IXC[i] = best;
    total += bestErr;
  }
  return total;
}

/** Least-squares endpoints (the first `channels` of RGBA) for the steps ix of weights, into E. False when every pixel uses the same step. */
function refine(px, ix, weights, channels) {
  let aa = 0, ab = 0, bb = 0;
  SUMS.fill(0);
  for (let i = 0; i < 16; i++) {
    const w = weights[ix[i]] / 64, a = 1 - w;
    aa += a * a; ab += a * w; bb += w * w;
    for (let c = 0; c < channels; c++) { SUMS[c] += a * px[i * 4 + c]; SUMS[4 + c] += w * px[i * 4 + c]; }
  }
  const det = aa * bb - ab * ab;
  if (det < 1e-6) return false;
  for (let c = 0; c < channels; c++) {
    E[c] = clamp255((bb * SUMS[c] - ab * SUMS[4 + c]) / det);
    E[4 + c] = clamp255((aa * SUMS[4 + c] - ab * SUMS[c]) / det);
  }
  return true;
}

/** Mode 6 for px into QB / PB / IXB: a few rounds of best endpoints for these steps, best steps for those endpoints. Answers the squared error. */
function mode6(px, full, zero) {
  principal(px, true);
  quantize(full, zero);
  let best = fitIndices(px);
  QB.set(Q); PB.set(P); IXB.set(IXC);
  for (let it = 0; it < 3 && best > 0; it++) {
    if (!refine(px, IXC, W4, 4)) break;
    quantize(full, zero);
    const err = fitIndices(px);
    if (err >= best) break;
    best = err; QB.set(Q); PB.set(P); IXB.set(IXC);
  }
  return best;
}

/** Mode 5 colour: the best of the 4 steps between the endpoints CQ for every pixel, into CI; answers the squared error. */
function fitColour5(px) {
  for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) PAL[k * 4 + c] = mix(x7(CQ[c]), x7(CQ[3 + c]), W2[k]);
  let total = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0, bestErr = Infinity;
    for (let k = 0; k < 4; k++) {
      const er = PAL[k * 4] - px[i * 4], eg = PAL[k * 4 + 1] - px[i * 4 + 1], eb = PAL[k * 4 + 2] - px[i * 4 + 2];
      const err = er * er + eg * eg + eb * eb;
      if (err < bestErr) { bestErr = err; best = k; }
    }
    CI[i] = best;
    total += bestErr;
  }
  return total;
}

/** Mode 5 for px into CQB / CIB (colour) and ALPHA / AI (alpha, from the lowest to the highest alpha, so both ends are exact). Answers the squared error. */
function mode5(px) {
  const quantize5 = () => { for (let c = 0; c < 3; c++) { CQ[c] = q7n(E[c]); CQ[3 + c] = q7n(E[4 + c]); } };
  principal(px, false);
  quantize5();
  let best = fitColour5(px);
  CQB.set(CQ); CIB.set(CI);
  for (let it = 0; it < 2 && best > 0; it++) {
    if (!refine(px, CI, W2, 3)) break;
    quantize5();
    const err = fitColour5(px);
    if (err >= best) break;
    best = err; CQB.set(CQ); CIB.set(CI);
  }
  let lo = 255, hi = 0;
  for (let i = 3; i < 64; i += 4) { if (px[i] < lo) lo = px[i]; if (px[i] > hi) hi = px[i]; }
  ALPHA[0] = lo; ALPHA[1] = hi;
  for (let i = 0; i < 16; i++) {
    let k = 0, bestErr = Infinity;
    for (let j = 0; j < 4; j++) { const d = mix(lo, hi, W2[j]) - px[i * 4 + 3]; if (d * d < bestErr) { bestErr = d * d; k = j; } }
    AI[i] = k;
    best += bestErr;
  }
  return best;
}

/** How many of the block's fully opaque or fully transparent pixels would decode to another alpha (alphaOf(i): the alpha pixel i decodes to). */
function changedOpacity(px, alphaOf) {
  let n = 0;
  for (let i = 0; i < 16; i++) { const a = px[i * 4 + 3]; if ((a === 0 || a === 255) && alphaOf(i) !== a) n++; }
  return n;
}

/**
 * One colour: a channel whose low bit matches the p-bit is stored as it is; any other channel gets endpoints one either side
 * of it, and step 7 (weight 30) lands exactly on it: ((64 - 30) * (c - 1) + 30 * (c + 1) + 32) >> 6 = c.
 */
function flatBlock(px) {
  let p = px[3] === 255 ? 1 : 0;                       // p-bit 1 cannot give 0, p-bit 0 cannot give 255: alpha 0 and 255 come first
  if (px[3] !== 0 && px[3] !== 255) {
    let zeros = 0, fulls = 0;
    for (let c = 0; c < 3; c++) { if (px[c] === 0) zeros++; if (px[c] === 255) fulls++; }
    p = zeros > fulls ? 0 : 1;
  }
  for (let c = 0; c < 4; c++) {
    const v = px[c];
    let lo = v, hi = v;
    if ((v & 1) !== p) { if (v > 0 && v < 255) { lo = v - 1; hi = v + 1; } else lo = hi = v === 0 ? 1 : 254; }
    QB[c] = lo; QB[4 + c] = hi;
  }
  PB[0] = PB[1] = p;
  IXB.fill(7);
}

let DST = null, WBIT = 0;
function put(v, n) { for (let i = 0; i < n; i++, WBIT++) if ((v >> i) & 1) DST[WBIT >> 3] |= 1 << (WBIT & 7); }

/** Write QB / PB / IXB as a mode 6 block at out[o]. */
function writeMode6(out, o) {
  if (IXB[0] & 8) {                                    // pixel 0's index is stored with 3 bits: swap the endpoints so its top bit is 0
    for (let c = 0; c < 4; c++) { const t = QB[c]; QB[c] = QB[4 + c]; QB[4 + c] = t; }
    const t = PB[0]; PB[0] = PB[1]; PB[1] = t;
    for (let i = 0; i < 16; i++) IXB[i] = 15 - IXB[i];
  }
  out.fill(0, o, o + 16);
  DST = out; WBIT = o * 8;
  put(1 << 6, 7);                                      // mode 6: six 0 bits, then a 1
  for (let c = 0; c < 4; c++) { put(QB[c] >> 1, 7); put(QB[4 + c] >> 1, 7); }
  put(PB[0], 1); put(PB[1], 1);
  put(IXB[0], 3);
  for (let i = 1; i < 16; i++) put(IXB[i], 4);
}

/** Write CQB / CIB / ALPHA / AI as a mode 5 block (no rotation) at out[o]. */
function writeMode5(out, o) {
  if (CIB[0] & 2) {                                    // pixel 0's indices are stored with 1 bit: swap a pair of endpoints whose index there is 2 or 3
    for (let c = 0; c < 3; c++) { const t = CQB[c]; CQB[c] = CQB[3 + c]; CQB[3 + c] = t; }
    for (let i = 0; i < 16; i++) CIB[i] = 3 - CIB[i];
  }
  if (AI[0] & 2) {
    const t = ALPHA[0]; ALPHA[0] = ALPHA[1]; ALPHA[1] = t;
    for (let i = 0; i < 16; i++) AI[i] = 3 - AI[i];
  }
  out.fill(0, o, o + 16);
  DST = out; WBIT = o * 8;
  put(1 << 5, 6);                                      // mode 5: five 0 bits, then a 1
  put(0, 2);                                           // rotation: none
  for (let c = 0; c < 3; c++) { put(CQB[c], 7); put(CQB[3 + c], 7); }
  put(ALPHA[0], 8); put(ALPHA[1], 8);
  put(CIB[0], 1);
  for (let i = 1; i < 16; i++) put(CIB[i], 2);
  put(AI[0], 1);
  for (let i = 1; i < 16; i++) put(AI[i], 2);
}

/** Encode 16 pixels (row by row, RGBA) as one block at out[o]. */
function encodeBlock(px, out, o) {
  let full = false, zero = false, flat = true, alphaVaries = false;
  for (let i = 0; i < 64; i += 4) {
    const a = px[i + 3];
    if (a === 255) full = true; else if (a === 0) zero = true;
    if (a !== px[3]) alphaVaries = true;
    if (px[i] !== px[0] || px[i + 1] !== px[1] || px[i + 2] !== px[2] || a !== px[3]) flat = false;
  }
  if (flat) { flatBlock(px); writeMode6(out, o); return; }
  const err6 = mode6(px, full, zero);
  if (alphaVaries) {
    const err5 = mode5(px);
    const off6 = changedOpacity(px, (i) => mix(QB[3], QB[7], W4[IXB[i]]));
    const off5 = changedOpacity(px, (i) => mix(ALPHA[0], ALPHA[1], W2[AI[i]]));
    if (off5 < off6 || (off5 === off6 && err5 < err6)) { writeMode5(out, o); return; }
  }
  writeMode6(out, o);
}

/** Encode w x h RGBA pixels as BC7 blocks (edge blocks of sizes that are not a multiple of 4 repeat the last row / column). */
function encode(rgba, w, h) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const out = Buffer.alloc(bw * bh * 16), px = new Uint8Array(64);
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, o += 16) {
      for (let py = 0; py < 4; py++) {
        const y = Math.min(by * 4 + py, h - 1);
        for (let pxn = 0; pxn < 4; pxn++) {
          const x = Math.min(bx * 4 + pxn, w - 1), s = (y * w + x) * 4, d = (py * 4 + pxn) * 4;
          px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = rgba[s + 3];
        }
      }
      encodeBlock(px, out, o);
    }
  }
  return out;
}

module.exports = { decode, encode };
