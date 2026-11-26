// Fabric maps for the "Fabric look" dialog: pure pixel maths on RGBA arrays, with no page and no canvas, so test/fabric.test.js
// runs them in Node. Like texsize.js this file has no imports, and every export is `export const` / `export function`.
//
// A map is a grey, fully opaque RGBA picture centred on 128. Drawn over a print with the Hard light, Overlay or Soft light blend
// mode, 128 changes nothing, darker greys shade the print and lighter greys light it up:
//   foldsMap(rgba, w, h, { size, contrast })  the folds, creases and seams of a texture: its brightness minus a blurred copy (a
//                                              high-pass), so the colours and the big shading are gone and the cloth's own shading stays
//   grainMap(kind, w, h, { size, seed })      a fabric surface, one of GRAINS, with threads or stitches about `size` px apart
//   bend(rgba, w, h, folds, amount)           a layer's pixels moved along the folds, like Photoshop's Displace filter

export const GRAINS = ['cotton', 'jersey', 'denim', 'canvas', 'mesh', 'fleece', 'leather', 'noise'];

/** Brightness 0-255 of every pixel (see-through pixels count as mid grey). */
export function luminance(rgba, w, h) {
  const n = w * h, out = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = rgba[i + 3] / 255;
    out[p] = a * (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) + (1 - a) * 128;
  }
  return out;
}

function boxH(src, dst, w, h, r) {
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + (k < 0 ? 0 : k >= w ? w - 1 : k)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / n;
      const xa = x + r + 1, xs = x - r;
      sum += src[row + (xa >= w ? w - 1 : xa)] - src[row + (xs < 0 ? 0 : xs)];
    }
  }
}
function boxV(src, dst, w, h, r) {
  const n = 2 * r + 1, sums = new Float64Array(w);
  for (let k = -r; k <= r; k++) { const row = (k < 0 ? 0 : k >= h ? h - 1 : k) * w; for (let x = 0; x < w; x++) sums[x] += src[row + x]; }
  for (let y = 0; y < h; y++) {
    const row = y * w, add = (y + r + 1 >= h ? h - 1 : y + r + 1) * w, sub = (y - r < 0 ? 0 : y - r) * w;
    for (let x = 0; x < w; x++) { dst[row + x] = sums[x] / n; sums[x] += src[add + x] - src[sub + x]; }
  }
}

/** A soft blur of one value per pixel: three box blurs of radius r (close to a Gaussian blur of radius r), edge pixels repeated. */
export function blur(src, w, h, r) {
  r = Math.max(0, Math.round(r));
  const a = Float32Array.from(src);
  if (!r) return a;
  const b = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) { boxH(a, b, w, h, r); boxV(b, a, w, h, r); }
  return a;
}

/** The value that a fraction q of |values| stays under (values up to `max`, read in 1024 steps). */
function absPercentile(values, q, max) {
  const bins = new Uint32Array(1024), k = 1023 / max;
  for (let p = 0; p < values.length; p++) { const b = Math.abs(values[p]) * k; bins[b >= 1023 ? 1023 : b | 0]++; }
  const target = values.length * q;
  let acc = 0;
  for (let b = 0; b < 1024; b++) { acc += bins[b]; if (acc >= target) return (b + 1) / k; }
  return max;
}

/** One value per pixel as grey RGBA: 128 + v * gain. */
function toGrey(values, gain) {
  const out = new Uint8ClampedArray(values.length * 4);
  for (let p = 0, i = 0; p < values.length; p++, i += 4) {
    const v = 128 + values[p] * gain;
    out[i] = out[i + 1] = out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
}

/**
 * The folds and creases of a texture as a grey map. `size` is the fold size in pixels (the blur radius of the high-pass: small
 * keeps fine wrinkles and seams, big keeps wide folds too). The map is levelled so the strongest creases (the darkest half
 * percent) reach about 90 levels from grey whatever the texture, then `contrast` scales it. A texture without any shading
 * gives plain grey. Answers { rgba, gain }.
 */
export function foldsMap(rgba, w, h, { size = 8, contrast = 1 } = {}) {
  const L = luminance(rgba, w, h), B = blur(L, w, h, size);
  const H = new Float32Array(L.length);
  for (let p = 0; p < H.length; p++) H[p] = L[p] - B[p];
  const level = absPercentile(H, 0.995, 256);
  const gain = (level > 0.75 ? Math.min(8, 90 / level) : 0) * contrast;
  return { rgba: toGrey(H, gain), gain };
}

// ------------------------------------------------------------------ fabric grain
/** A repeatable random number 0-1 for whole numbers x, y and a seed. */
function hash(x, y, s) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(s | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (a, b, x) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t); };
/** Smooth random 0-1 that changes over about `cell` pixels. */
function valueNoise(x, y, cell, s) {
  const gx = x / cell, gy = y / cell, x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, s), b = hash(x0 + 1, y0, s), c = hash(x0, y0 + 1, s), d = hash(x0 + 1, y0 + 1, s);
  const top = a + (b - a) * sx;
  return top + (c + (d - c) * sx - top) * sy;
}

// Each pattern answers the surface at (x, y) for threads about P pixels apart: about -1 (deep) to 1 (raised). The map is
// levelled afterwards, so only the shape matters.
const PATTERNS = {
  /** plain weave: a thread over, a thread under; every thread a little different */
  cotton(x, y, P, s) { return weave(x, y, P, s, 0.5); },
  /** jersey knit, the face of a T-shirt: columns of V-shaped stitches, each V two loops (threads) P apart */
  jersey(x, y, P, s) {
    const gx = x / (2 * P), i = Math.floor(gx), u = gx - i - 0.5;         // across one column of stitches, -0.5 .. 0.5
    const gy = y / (P * 1.6) + Math.abs(u) * 1.2;                          // V shaped: the sides of a stitch sit lower than its middle
    const j = Math.floor(gy), fy = gy - j;
    const legs = Math.sin(Math.PI * Math.min(1, Math.abs(u) * 2));        // the two legs of the V, a groove between them and between columns
    const loop = 0.4 + 0.6 * Math.sin(Math.PI * fy);                      // each loop is round along its length
    return legs * loop * 2 - 1 + 0.35 * (hash(i, j, s) - 0.5);
  },
  /** denim twill: steep diagonal ribs over the warp yarns, with the long uneven streaks of denim yarn */
  denim(x, y, P, s) {
    const rib = Math.sin(2 * Math.PI * (2 * x - y) / (2.236 * P));
    const yarn = Math.sin(Math.PI * ((x / (P * 0.5)) % 1));
    const slub = valueNoise(x * 0.3, y * 0.03, P, s) * 2 - 1;
    return 0.6 * rib + 0.2 * (yarn * 2 - 1) + 0.4 * slub;
  },
  /** canvas: a coarse plain weave of uneven threads */
  canvas(x, y, P, s) { return weave(x, y, P * 1.7, s, 1.1) + 0.25 * (valueNoise(x, y, P * 4, s + 9) * 2 - 1); },
  /** sports mesh: rows of small holes, every other row shifted */
  mesh(x, y, P, s) {
    const c = P * 2, rh = c * 0.866, row = Math.floor(y / rh);
    let best = Infinity;
    for (let r = row - 1; r <= row + 1; r++) {
      const o = (r & 1) * 0.5, k0 = Math.round(x / c - o);
      for (let k = k0 - 1; k <= k0 + 1; k++) {
        const dx = x - (k + o) * c, dy = y - (r + 0.5) * rh, d = dx * dx + dy * dy;
        if (d < best) best = d;
      }
    }
    const rad = c * 0.27, hole = 1 - smooth(rad * 0.75, rad * 1.15, Math.sqrt(best));
    return -1.3 * hole + 0.3 * (1 - hole) + 0.15 * (hash(x | 0, y | 0, s) - 0.5);
  },
  /** fleece: soft and fuzzy, small pills and loose fibres instead of threads */
  fleece(x, y, P, s) { return (valueNoise(x, y, P * 1.5, s) * 0.35 + valueNoise(x, y, P * 0.6, s + 1) * 0.35 + hash(x | 0, y | 0, s + 2) * 0.3) * 2 - 1; },
  /** leather: pebbled grain, little cells with creases between them */
  leather(x, y, P, s) {
    const c = P * 3, gx = x / c, gy = y / c, ix = Math.floor(gx), iy = Math.floor(gy);
    let f1 = Infinity, f2 = Infinity;
    for (let j = iy - 1; j <= iy + 1; j++) {
      for (let i = ix - 1; i <= ix + 1; i++) {
        const dx = gx - (i + 0.15 + 0.7 * hash(i, j, s)), dy = gy - (j + 0.15 + 0.7 * hash(i, j, s + 7)), d = dx * dx + dy * dy;   // centres kept apart: no tiny cells
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
      }
    }
    const crease = 1 - smooth(0, 0.18, Math.sqrt(f2) - Math.sqrt(f1));
    return 0.5 - 1.6 * crease + 0.25 * (hash(x | 0, y | 0, s + 3) - 0.5);
  },
  /** fine grain: speckle about P / 3 pixels big */
  noise(x, y, P, s) { const g = Math.max(1, P / 3); return hash(Math.floor(x / g), Math.floor(y / g), s) * 2 - 1; },
};

/** A plain weave of threads P apart: in every cell either the up-down or the across thread is on top. */
function weave(x, y, P, s, uneven) {
  const gx = x / P, gy = y / P, i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
  const warp = ((i + j) & 1) === 0;
  const round = Math.sin(Math.PI * (warp ? fx : fy));                     // a thread is round: light along its middle, dark at its sides
  const dip = 0.55 + 0.45 * Math.sin(Math.PI * (warp ? fy : fx));         // and lower where it goes under the threads that cross it
  const thread = hash(warp ? i : 7919 + j, warp ? 1 : 2, s) - 0.5;        // each thread a little lighter or darker
  return round * dip * 2 - 1 + uneven * thread;
}

/**
 * A fabric surface as a grey map: `kind` is one of GRAINS, `size` the distance between threads or stitches in pixels, `seed`
 * picks another (equally good) random variation. Levelled like foldsMap: average 128, the strongest 1 % reaching about 110
 * levels from grey, so every kind looks about as strong at the same opacity. Answers { rgba }.
 */
export function grainMap(kind, w, h, { size = 3, seed = 1 } = {}) {
  const f = PATTERNS[kind];
  if (!f) throw new Error('unknown fabric grain: ' + kind);
  const P = Math.max(1, size), ss = P < 6 ? 2 : 1, n = w * h, V = new Float32Array(n);
  let sum = 0;
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      let v = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) v += f(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss, P, seed);
      v /= ss * ss;
      V[p] = v; sum += v;
    }
  }
  const mean = sum / n;
  for (let p = 0; p < n; p++) V[p] -= mean;
  const level = absPercentile(V, 0.99, 4);
  return { rgba: toGrey(V, level > 1e-6 ? 110 / level : 0) };
}

// ------------------------------------------------------------------ bend
/**
 * Move a layer's pixels along the folds, like Photoshop's Displace filter with one grey map: every pixel is taken from a spot
 * up to `amount` px away, diagonally, as far as the fold map (grey RGBA, 128 = stay put) says, so the straight lines of a print
 * wave with the creases. The map is softened first (more for a bigger amount) so the print bends instead of tearing. Colours are blended premultiplied
 * (no dark rims at see-through edges); at the picture's edges the edge pixels repeat. Answers new RGBA.
 */
export function bend(rgba, w, h, folds, amount) {
  const n = w * h, out = new Uint8ClampedArray(n * 4);
  if (!amount) { out.set(rgba); return out; }
  const M = new Float32Array(n);
  for (let p = 0; p < n; p++) M[p] = (folds[p * 4] - 128) / 128;
  const D = blur(M, w, h, Math.max(2, Math.round(Math.abs(amount) * 0.6)));
  const pre = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i += 4) {
    const a = rgba[i + 3] / 255;
    pre[i] = rgba[i] * a; pre[i + 1] = rgba[i + 1] * a; pre[i + 2] = rgba[i + 2] * a; pre[i + 3] = rgba[i + 3];
  }
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      const d = D[p] * amount, sx = x - d, sy = y - d;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < 4; k++) {
        let cx = x0 + (k & 1), cy = y0 + (k >> 1);
        cx = cx < 0 ? 0 : cx >= w ? w - 1 : cx; cy = cy < 0 ? 0 : cy >= h ? h - 1 : cy;
        const wt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy), q = (cy * w + cx) * 4;
        r += pre[q] * wt; g += pre[q + 1] * wt; b += pre[q + 2] * wt; a += pre[q + 3] * wt;
      }
      const o = p * 4;
      if (a > 0.5) { const k = 255 / a; out[o] = r * k; out[o + 1] = g * k; out[o + 2] = b * k; out[o + 3] = a; }
    }
  }
  return out;
}
