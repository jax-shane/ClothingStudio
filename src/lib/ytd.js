'use strict';
// GTA V .ytd (texture dictionary): read, decode to RGBA, re-encode and patch
// the pixels back into the original file. Supports the formats addon clothing
// uses: DXT1, DXT5, BC7 and A8R8G8B8, including mip chains.

const fs = require('fs');
const zlib = require('zlib');
const { loadRsc, ptrAt, resolve, cstring } = require('./rsc');
const bc7 = require('./bc7');

const FMT = { DXT1: 0x31545844, DXT5: 0x35545844, BC7: 0x20374342, A8R8G8B8: 21 };

/** 'DXT1', 'BC7' ...; a format ClothingStudio cannot read shows its four letters when it has them ('ATI2 (0x32495441)'), else its number. */
function formatName(f) {
  for (const name of Object.keys(FMT)) if (FMT[name] === f) return name;
  const code = Buffer.alloc(4);
  code.writeUInt32LE(f >>> 0);
  const letters = code.toString('latin1'), hex = '0x' + (f >>> 0).toString(16);
  return /^[A-Z0-9]{3,4} ?$/.test(letters) ? `${letters.trim()} (${hex})` : hex;
}

// ------------------------------------------------------------------ layout
function levelSize(fmt, w, h) {
  if (fmt === FMT.DXT1) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * 8;
  if (fmt === FMT.DXT5 || fmt === FMT.BC7) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * 16;
  if (fmt === FMT.A8R8G8B8) return w * h * 4;
  throw new Error('unsupported texture format ' + formatName(fmt));
}

function chainSize(fmt, w, h, levels) {
  let total = 0;
  for (let l = 0; l < levels; l++) total += levelSize(fmt, Math.max(1, w >> l), Math.max(1, h >> l));
  return total;
}

function readYtd(file) {
  const rsc = loadRsc(file);
  const { buf } = rsc;
  const arr = resolve(rsc, ptrAt(buf, 0x30));
  const count = buf.readUInt16LE(0x38);
  if (arr < 0 || count === 0 || count > 512) throw new Error('unexpected texture dictionary layout');
  const textures = [];
  for (let i = 0; i < count; i++) {
    const t = resolve(rsc, ptrAt(buf, arr + i * 8));
    if (t < 0) throw new Error('bad texture pointer');
    const name = cstring(buf, resolve(rsc, ptrAt(buf, t + 0x28)));
    const width = buf.readUInt16LE(t + 0x50);
    const height = buf.readUInt16LE(t + 0x52);
    const stride = buf.readUInt16LE(t + 0x56);
    const format = buf.readUInt32LE(t + 0x58);
    const mips = buf[t + 0x5d];
    const dataOff = resolve(rsc, ptrAt(buf, t + 0x70));
    if (!name || width < 1 || height < 1 || width > 8192 || height > 8192 || dataOff < 0) {
      throw new Error('implausible texture header');
    }
    textures.push({ name, width, height, stride, format, formatName: formatName(format), mips, dataOff, objOff: t });
  }
  return { rsc, textures };
}

// ------------------------------------------------------------------ decode
function expand565(c, out, o) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  out[o] = (r << 3) | (r >> 2);
  out[o + 1] = (g << 2) | (g >> 4);
  out[o + 2] = (b << 3) | (b >> 2);
  out[o + 3] = 255;
}

function decodeDXT(buf, off, w, h, dxt5) {
  const out = new Uint8Array(w * h * 4);
  const bw = (w + 3) >> 2, bh = (h + 3) >> 2;
  const pal = new Uint8Array(16);
  const alpha = new Uint8Array(16);
  let pos = off;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (dxt5) {
        const a0 = buf[pos], a1 = buf[pos + 1];
        const lo = buf.readUIntLE(pos + 2, 3), hi = buf.readUIntLE(pos + 5, 3);
        const lut = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) lut.push(Math.floor(((7 - i) * a0 + i * a1) / 7));
        else { for (let i = 1; i < 5; i++) lut.push(Math.floor(((5 - i) * a0 + i * a1) / 5)); lut.push(0, 255); }
        for (let i = 0; i < 16; i++) alpha[i] = lut[(i < 8 ? (lo >> (3 * i)) : (hi >> (3 * (i - 8)))) & 7];
        pos += 8;
      }
      const c0 = buf.readUInt16LE(pos), c1 = buf.readUInt16LE(pos + 2), bits = buf.readUInt32LE(pos + 4);
      pos += 8;
      expand565(c0, pal, 0); expand565(c1, pal, 4);
      if (c0 > c1 || dxt5) {
        for (let k = 0; k < 3; k++) {
          pal[8 + k] = Math.floor((2 * pal[k] + pal[4 + k]) / 3);
          pal[12 + k] = Math.floor((pal[k] + 2 * pal[4 + k]) / 3);
        }
        pal[11] = 255; pal[15] = 255;
      } else {
        for (let k = 0; k < 3; k++) { pal[8 + k] = (pal[k] + pal[4 + k]) >> 1; pal[12 + k] = 0; }
        pal[11] = 255; pal[15] = 0;
      }
      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= h) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= w) break;
          const idx = (bits >>> (2 * (py * 4 + px))) & 3;
          const o = (y * w + x) * 4;
          out[o] = pal[idx * 4]; out[o + 1] = pal[idx * 4 + 1]; out[o + 2] = pal[idx * 4 + 2];
          out[o + 3] = dxt5 ? alpha[py * 4 + px] : pal[idx * 4 + 3];
        }
      }
    }
  }
  return out;
}

function decodeBGRA(buf, off, w, h, stride) {
  stride = Math.max(stride, w * 4);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    let s = off + y * stride, o = y * w * 4;
    for (let x = 0; x < w; x++, s += 4, o += 4) {
      out[o] = buf[s + 2]; out[o + 1] = buf[s + 1]; out[o + 2] = buf[s]; out[o + 3] = buf[s + 3];
    }
  }
  return out;
}

function decodeLevel(buf, off, fmt, w, h, stride) {
  if (fmt === FMT.DXT1) return decodeDXT(buf, off, w, h, false);
  if (fmt === FMT.DXT5) return decodeDXT(buf, off, w, h, true);
  if (fmt === FMT.BC7) return bc7.decode(buf, off, w, h);
  if (fmt === FMT.A8R8G8B8) return decodeBGRA(buf, off, w, h, stride);
  throw new Error('unsupported texture format ' + formatName(fmt));
}

/** Decode the top mip of texture `index` to RGBA. */
function decodeTexture(ytd, index = 0) {
  const t = ytd.textures[index];
  const rgba = decodeLevel(ytd.rsc.buf, t.dataOff, t.format, t.width, t.height, t.stride);
  return { name: t.name, width: t.width, height: t.height, format: t.formatName, mips: t.mips, rgba };
}

// ------------------------------------------------------------------ encode
const to565 = (r, g, b) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

function encodeColorBlock(px, out, o, allowAlpha) {
  // px: 16 RGBA pixels (64 bytes). Bounding-box endpoint fit with a small inset.
  let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0, transparent = false;
  for (let i = 0; i < 16; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (allowAlpha && px[i * 4 + 3] < 128) { transparent = true; continue; }
    if (r < minR) minR = r; if (g < minG) minG = g; if (b < minB) minB = b;
    if (r > maxR) maxR = r; if (g > maxG) maxG = g; if (b > maxB) maxB = b;
  }
  if (minR > maxR) { minR = minG = minB = maxR = maxG = maxB = 0; } // fully transparent block
  const ir = (maxR - minR) >> 4, ig = (maxG - minG) >> 4, ib = (maxB - minB) >> 4;
  let c0 = to565(Math.min(255, maxR - ir), Math.min(255, maxG - ig), Math.min(255, maxB - ib));
  let c1 = to565(Math.max(0, minR + ir), Math.max(0, minG + ig), Math.max(0, minB + ib));
  const fourColour = !transparent;
  if (fourColour) { if (c0 < c1) { const t = c0; c0 = c1; c1 = t; } }
  else if (c0 > c1) { const t = c0; c0 = c1; c1 = t; }

  const pal = new Uint8Array(16);
  expand565(c0, pal, 0); expand565(c1, pal, 4);
  const n = fourColour ? 4 : 3;
  for (let k = 0; k < 3; k++) {
    if (fourColour) { pal[8 + k] = Math.floor((2 * pal[k] + pal[4 + k]) / 3); pal[12 + k] = Math.floor((pal[k] + 2 * pal[4 + k]) / 3); }
    else pal[8 + k] = (pal[k] + pal[4 + k]) >> 1;
  }

  let bits = 0;
  if (c0 !== c1 || transparent) {
    for (let i = 0; i < 16; i++) {
      let best = 0;
      if (transparent && allowAlpha && px[i * 4 + 3] < 128) best = 3;
      else {
        let bd = 1e9;
        for (let k = 0; k < n; k++) {
          const dr = px[i * 4] - pal[k * 4], dg = px[i * 4 + 1] - pal[k * 4 + 1], db = px[i * 4 + 2] - pal[k * 4 + 2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bd) { bd = d; best = k; }
        }
      }
      bits |= best << (2 * i);
    }
  }
  out.writeUInt16LE(c0, o); out.writeUInt16LE(c1, o + 2); out.writeUInt32LE(bits >>> 0, o + 4);
}

function encodeAlphaBlock(px, out, o) {
  let a0 = 0, a1 = 255;
  for (let i = 0; i < 16; i++) { const a = px[i * 4 + 3]; if (a > a0) a0 = a; if (a < a1) a1 = a; }
  // a0 >= a1 -> 8 value interpolation mode (a0 > a1); identical values use index 0
  const lut = [a0, a1];
  for (let i = 1; i < 7; i++) lut.push(Math.floor(((7 - i) * a0 + i * a1) / 7));
  out[o] = a0; out[o + 1] = a1;
  let lo = 0, hi = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0, bd = 1e9;
    if (a0 !== a1) for (let k = 0; k < 8; k++) { const d = Math.abs(px[i * 4 + 3] - lut[k]); if (d < bd) { bd = d; best = k; } }
    if (i < 8) lo |= best << (3 * i); else hi |= best << (3 * (i - 8));
  }
  out.writeUIntLE(lo >>> 0, o + 2, 3); out.writeUIntLE(hi >>> 0, o + 5, 3);
}

function encodeDXT(rgba, w, h, dxt5) {
  const bw = (w + 3) >> 2, bh = (h + 3) >> 2, bs = dxt5 ? 16 : 8;
  const out = Buffer.alloc(bw * bh * bs);
  const px = new Uint8Array(64);
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let py = 0; py < 4; py++) {
        const y = Math.min(by * 4 + py, h - 1);
        for (let pxn = 0; pxn < 4; pxn++) {
          const x = Math.min(bx * 4 + pxn, w - 1);
          const s = (y * w + x) * 4, d = (py * 4 + pxn) * 4;
          px[d] = rgba[s]; px[d + 1] = rgba[s + 1]; px[d + 2] = rgba[s + 2]; px[d + 3] = rgba[s + 3];
        }
      }
      if (dxt5) { encodeAlphaBlock(px, out, o); encodeColorBlock(px, out, o + 8, false); }
      else encodeColorBlock(px, out, o, true);
      o += bs;
    }
  }
  return out;
}

function encodeBGRA(rgba, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    out[i] = rgba[i + 2]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i]; out[i + 3] = rgba[i + 3];
  }
  return out;
}

function encodeLevel(rgba, w, h, fmt) {
  if (fmt === FMT.DXT1) return encodeDXT(rgba, w, h, false);
  if (fmt === FMT.DXT5) return encodeDXT(rgba, w, h, true);
  if (fmt === FMT.BC7) return bc7.encode(rgba, w, h);
  if (fmt === FMT.A8R8G8B8) return encodeBGRA(rgba, w, h);
  throw new Error('unsupported texture format ' + formatName(fmt));
}

function halve(rgba, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
      const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
      for (let k = 0; k < 4; k++) out[(y * nw + x) * 4 + k] = (rgba[a + k] + rgba[b + k] + rgba[c + k] + rgba[d + k] + 2) >> 2;
    }
  }
  return { rgba: out, w: nw, h: nh };
}

/** Encode the full mip chain for a texture as it is laid out in the file. */
function buildChain(rgba, w, h, fmt, levels) {
  const parts = [];
  let cur = { rgba, w, h };
  for (let l = 0; l < levels; l++) {
    parts.push(encodeLevel(cur.rgba, cur.w, cur.h, fmt));
    if (l + 1 < levels) cur = halve(cur.rgba, cur.w, cur.h);
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ write back
/**
 * Replace the pixels of texture `index` in `file` with `rgba` (same width/height
 * as the original). The first time a file is changed the untouched original is
 * kept next to it as "<file>.bak"; an existing .bak is never overwritten.
 */
function patchTexture(file, index, rgba, opts = {}) {
  const ytd = readYtd(file);
  const t = ytd.textures[index];
  if (rgba.length !== t.width * t.height * 4) {
    throw new Error(`pixel data is ${rgba.length / 4} px, texture is ${t.width}x${t.height}`);
  }
  const chain = buildChain(rgba, t.width, t.height, t.format, t.mips);
  const expect = chainSize(t.format, t.width, t.height, t.mips);
  if (chain.length !== expect) throw new Error('internal error: mip chain size mismatch');
  if (t.dataOff + chain.length > ytd.rsc.buf.length) {
    throw new Error('texture data would run past the end of the file; refusing to write');
  }

  const original = fs.readFileSync(file);
  const bak = file + '.bak';
  let madeBackup = false;
  if (opts.backup !== false && !fs.existsSync(bak)) { fs.writeFileSync(bak, original); madeBackup = true; }

  chain.copy(ytd.rsc.buf, t.dataOff);
  const body = zlib.deflateRawSync(ytd.rsc.buf, { level: 9 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([original.subarray(0, 16), body]));

  // verify the new file before it replaces the old one
  const meanError = meanErrorOf(readYtd(tmp), index, rgba, t.format);
  if (meanError > 40) { fs.unlinkSync(tmp); throw new Error('verification failed (mean error ' + meanError.toFixed(1) + '); file left untouched'); }
  fs.renameSync(tmp, file);
  return { file, backup: madeBackup ? bak : (fs.existsSync(bak) ? bak : null), meanError, bytes: body.length + 16 };
}

/** How far (mean absolute difference per channel, 0-255) texture `index` of a freshly read .ytd is from the pixels that were meant to be written. */
function meanErrorOf(ytd, index, rgba, format) {
  const check = decodeTexture(ytd, index);
  let ref = rgba;
  if (format === FMT.DXT1) {                           // DXT1 only has on/off alpha, and transparent pixels carry no colour
    ref = Buffer.from(rgba);
    for (let i = 0; i < ref.length; i += 4) {
      if (ref[i + 3] < 128) ref[i] = ref[i + 1] = ref[i + 2] = ref[i + 3] = 0; else ref[i + 3] = 255;
    }
  }
  let err = 0;
  for (let i = 0; i < ref.length; i++) err += Math.abs(check.rgba[i] - ref[i]);
  return err / ref.length;
}

// ------------------------------------------------------------------ change the size
// patchTexture can only rewrite pixels at the size the file already has. Changing the size means a new inflated image:
// the system segment as it was (only this texture's header changes: width, height, stride, mip count) followed by one
// graphics page that holds the new mip chain. The page is laid out exactly like the one in the bundled template:
// the smallest power-of-two page that fits, flagged as "one page of 16 base pages" (base = 0x200 << shift), padded with
// the 0xCD fill real files use, and the resource version bits of the old flags are kept.

const MAX_RESIZE = 4096;                               // the largest side ClothingStudio writes (a 4096 x 4096 DXT1 texture is about 11 MB in memory, DXT5 about 22 MB)
const isPow2 = (n) => Number.isInteger(n) && n >= 4 && (n & (n - 1)) === 0;
const fullChain = (w, h) => Math.floor(Math.log2(Math.max(w, h))) + 1;           // levels from w x h down to 1 x 1
const strideFor = (fmt, w) => (fmt === FMT.DXT1 ? w / 2 : fmt === FMT.DXT5 || fmt === FMT.BC7 ? w : w * 4);   // bytes of one row of pixels at the format's bits per pixel (the template: 1024 wide DXT1 = 512)

/** Mip levels for a new size: a file that stops short of 1 x 1 (the bundled template stops at 4 x 4) keeps stopping just as far short. */
function mipsForSize(t, w, h) {
  if (t.mips <= 1) return 1;
  const skipped = Math.max(0, fullChain(t.width, t.height) - t.mips);
  return Math.max(1, fullChain(w, h) - skipped);
}

/** Graphics page flags for pixel data of `bytes` bytes: one page of 0x2000 << shift bytes, the smallest that fits. */
function pageFlagsFor(bytes, oldFlags) {
  let shift = 0;
  while (shift < 15 && 0x2000 * 2 ** shift < bytes) shift++;
  const size = 0x2000 * 2 ** shift;
  if (size < bytes) throw new Error('texture data is too large for one page');
  return { size, flags: ((((oldFlags >>> 28) << 28) | (1 << 17) | shift) >>> 0) };       // top 4 bits: version, kept; bit 17: one page of 16 base pages
}

/**
 * Write `rgba` (width x height pixels) as texture `index` of `file`, changing the texture's size. Only a dictionary that
 * holds a single texture can change size, and the sides must be powers of two between 4 and MAX_RESIZE. The format and name stay,
 * the mip levels are regenerated. Like patchTexture: the original is kept once as "<file>.bak", the new file is read back and
 * checked before it replaces the old one, and on any error the old file is left exactly as it was.
 */
function resizeTexture(file, index, width, height, rgba, opts = {}) {
  if (!isPow2(width) || !isPow2(height) || width > MAX_RESIZE || height > MAX_RESIZE) {
    throw new Error(`A texture must be a power of two wide and high, from 4 to ${MAX_RESIZE} pixels (${width}x${height} is not).`);
  }
  if (rgba.length !== width * height * 4) throw new Error(`pixel data is ${rgba.length / 4} px, new size is ${width}x${height}`);
  const ytd = readYtd(file), { rsc } = ytd;
  if (ytd.textures.length !== 1 || index !== 0) throw new Error('Only a .ytd that holds a single texture can change size.');
  const t = ytd.textures[0];
  if (t.dataOff !== rsc.sysSize || rsc.buf.length < rsc.sysSize) throw new Error('unexpected texture layout (the pixels do not start the graphics segment); refusing to resize');

  const mips = mipsForSize(t, width, height);
  const chain = buildChain(rgba, width, height, t.format, mips);
  if (chain.length !== chainSize(t.format, width, height, mips)) throw new Error('internal error: mip chain size mismatch');
  const page = pageFlagsFor(chain.length, rsc.gflags);
  const out = Buffer.alloc(rsc.sysSize + page.size, 0xcd);
  rsc.buf.copy(out, 0, 0, rsc.sysSize);
  chain.copy(out, rsc.sysSize);
  out.writeUInt16LE(width, t.objOff + 0x50);
  out.writeUInt16LE(height, t.objOff + 0x52);
  out.writeUInt16LE(t.stride ? Math.round(t.stride * width / t.width) : strideFor(t.format, width), t.objOff + 0x56);
  out[t.objOff + 0x5d] = mips;

  const original = fs.readFileSync(file);
  const head = Buffer.from(original.subarray(0, 16));
  head.writeUInt32LE(page.flags, 12);
  const bak = file + '.bak';
  let madeBackup = false;
  if (opts.backup !== false && !fs.existsSync(bak)) { fs.writeFileSync(bak, original); madeBackup = true; }
  const body = zlib.deflateRawSync(out, { level: 9 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([head, body]));

  // read the new file back and check it says what we meant before it replaces the old one
  let meanError;
  try {
    const back = readYtd(tmp), b = back.textures[0];
    if (back.textures.length !== 1 || b.name !== t.name || b.format !== t.format || b.width !== width || b.height !== height || b.mips !== mips
        || back.rsc.sysSize !== rsc.sysSize || back.rsc.gfxSize !== page.size || back.rsc.buf.length !== out.length) {
      throw new Error('verification failed (the new file does not read back as written); file left untouched');
    }
    meanError = meanErrorOf(back, 0, rgba, t.format);
    if (meanError > 40) throw new Error('verification failed (mean error ' + meanError.toFixed(1) + '); file left untouched');
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  fs.renameSync(tmp, file);
  return { file, backup: madeBackup ? bak : (fs.existsSync(bak) ? bak : null), meanError, bytes: head.length + body.length, width, height, mips, resized: true };
}

/** Change the texture name stored inside a one-texture dictionary (its name string and the hash in the dictionary header). */
function renameInner(file, newName) {
  if (!/^[A-Za-z0-9_]{1,40}$/.test(newName)) throw new Error('bad texture name');
  const rsc = loadRsc(file), buf = rsc.buf;
  const arr = resolve(rsc, ptrAt(buf, 0x30));
  const t = resolve(rsc, ptrAt(buf, arr));
  const nameOff = resolve(rsc, ptrAt(buf, t + 0x28));
  const hashOff = resolve(rsc, ptrAt(buf, 0x20));
  if (nameOff < 0 || hashOff < 0 || buf.readUInt16LE(0x38) !== 1) throw new Error('unexpected texture dictionary layout');
  buf.fill(0, nameOff, nameOff + 48);
  buf.write(newName, nameOff, 'latin1');
  let h = 0;
  for (const c of Buffer.from(newName.toLowerCase(), 'latin1')) { h = (h + c) >>> 0; h = (h + (h << 10)) >>> 0; h ^= h >>> 6; h >>>= 0; }
  h = (h + (h << 3)) >>> 0; h ^= h >>> 11; h >>>= 0; h = (h + (h << 15)) >>> 0;
  buf.writeUInt32LE(h >>> 0, hashOff);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([original.subarray(0, 16), zlib.deflateRawSync(buf, { level: 9 })]));
}

module.exports = { FMT, MAX_RESIZE, formatName, readYtd, decodeTexture, decodeLevel, patchTexture, resizeTexture, mipsForSize, pageFlagsFor, buildChain, chainSize, levelSize, renameInner };
