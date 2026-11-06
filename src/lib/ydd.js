'use strict';
// Reads GTA V .ydd (drawable dictionary) meshes: positions, normals, UVs and
// triangle indices for each geometry of the highest LOD. Layout follows the
// open-source CodeWalker reader (Drawable.cs).

const { loadRsc, ptrAt, resolve, cstring } = require('./rsc');

// VertexDeclaration component types -> byte size
const TYPE_SIZE = { 0: 0, 1: 4, 2: 4, 3: 8, 4: 4, 5: 8, 6: 12, 7: 16, 8: 4, 9: 4, 10: 4, 11: 4, 12: 4, 13: 4, 14: 4, 15: 4 };
const T = { HALF2: 1, FLOAT: 2, HALF4: 3, FLOAT2: 5, FLOAT3: 6, FLOAT4: 7, UBYTE4: 8, COLOUR: 9 };
const SLOT = { POSITION: 0, BLENDWEIGHTS: 1, BLENDINDICES: 2, NORMAL: 3, COLOUR0: 4, COLOUR1: 5, TEXCOORD0: 6, TANGENT: 14 };

function half(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

function readComponent(buf, off, type, out, outOff, count) {
  switch (type) {
    case T.FLOAT: case T.FLOAT2: case T.FLOAT3: case T.FLOAT4: {
      const n = type === T.FLOAT ? 1 : type - 3;
      for (let i = 0; i < Math.min(n, count); i++) out[outOff + i] = buf.readFloatLE(off + i * 4);
      return;
    }
    case T.HALF2: case T.HALF4: {
      const n = type === T.HALF2 ? 2 : 4;
      for (let i = 0; i < Math.min(n, count); i++) out[outOff + i] = half(buf.readUInt16LE(off + i * 2));
      return;
    }
    default:
      for (let i = 0; i < Math.min(4, count); i++) out[outOff + i] = buf[off + i] / 255;
  }
}

function readGeometry(rsc, gOff) {
  const { buf } = rsc;
  const vb = resolve(rsc, ptrAt(buf, gOff + 0x18));
  const ib = resolve(rsc, ptrAt(buf, gOff + 0x38));
  if (vb < 0 || ib < 0) return null;

  const indexCount = buf.readUInt32LE(gOff + 0x58);
  const stride = buf.readUInt16LE(vb + 0x08);
  const vertexCount = buf.readUInt32LE(vb + 0x18);
  const vData = resolve(rsc, ptrAt(buf, vb + 0x10));
  const decl = resolve(rsc, ptrAt(buf, vb + 0x30));
  const iData = resolve(rsc, ptrAt(buf, ib + 0x10));
  if (vData < 0 || decl < 0 || iData < 0) return null;

  const flags = buf.readUInt32LE(decl);
  const types = buf.readBigUInt64LE(decl + 8);
  const attrs = {};
  let o = 0;
  for (let slot = 0; slot < 16; slot++) {
    if (!((flags >>> slot) & 1)) continue;
    const type = Number((types >> BigInt(slot * 4)) & 0xfn);
    attrs[slot] = { type, off: o };
    o += TYPE_SIZE[type];
  }
  if (o !== stride) throw new Error(`vertex layout mismatch: components sum to ${o} bytes but stride is ${stride}`);

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const tmp = [0, 0, 0, 0];
  const p = attrs[SLOT.POSITION], n = attrs[SLOT.NORMAL], t = attrs[SLOT.TEXCOORD0];
  for (let i = 0; i < vertexCount; i++) {
    const base = vData + i * stride;
    if (p) { readComponent(buf, base + p.off, p.type, tmp, 0, 3); positions.set(tmp.slice(0, 3), i * 3); }
    if (n) { readComponent(buf, base + n.off, n.type, tmp, 0, 3); normals.set(tmp.slice(0, 3), i * 3); }
    if (t) { readComponent(buf, base + t.off, t.type, tmp, 0, 2); uvs[i * 2] = tmp[0]; uvs[i * 2 + 1] = tmp[1]; }
  }

  const indices = new Uint16Array(indexCount);
  for (let i = 0; i < indexCount; i++) indices[i] = buf.readUInt16LE(iData + i * 2);

  return { vertexCount, indexCount, stride, declFlags: flags, positions, normals: n ? normals : null, uvs: t ? uvs : null, indices };
}

function readModelList(rsc, listPtr) {
  const { buf } = rsc;
  const list = resolve(rsc, listPtr);
  if (list < 0) return [];
  const arr = resolve(rsc, ptrAt(buf, list));
  const count = buf.readUInt16LE(list + 8);
  if (arr < 0 || count === 0 || count > 64) return [];
  const models = [];
  for (let i = 0; i < count; i++) {
    const m = resolve(rsc, ptrAt(buf, arr + i * 8));
    if (m < 0) continue;
    const gArr = resolve(rsc, ptrAt(buf, m + 0x08));
    const gCount = buf.readUInt16LE(m + 0x10);
    const geoms = [];
    for (let j = 0; j < gCount && gArr >= 0; j++) {
      const g = resolve(rsc, ptrAt(buf, gArr + j * 8));
      const geo = g < 0 ? null : readGeometry(rsc, g);
      if (geo) geoms.push(geo);
    }
    models.push({ geometries: geoms });
  }
  return models;
}

/** Parse a .ydd and return its drawables (highest LOD only). */
function readYdd(file) {
  const rsc = loadRsc(file);
  const { buf } = rsc;
  const dict = 0; // the dictionary object sits at the start of the system segment
  const dPtrArr = resolve(rsc, ptrAt(buf, dict + 0x30));
  const dCount = buf.readUInt16LE(dict + 0x38);
  const hashes = resolve(rsc, ptrAt(buf, dict + 0x20));
  if (dPtrArr < 0 || dCount === 0 || dCount > 64) throw new Error('unexpected drawable dictionary layout');

  const drawables = [];
  for (let i = 0; i < dCount; i++) {
    const d = resolve(rsc, ptrAt(buf, dPtrArr + i * 8));
    if (d < 0) continue;
    const models = readModelList(rsc, ptrAt(buf, d + 0x50));
    const nameOff = resolve(rsc, ptrAt(buf, d + 0xa8));
    drawables.push({
      hash: hashes >= 0 ? buf.readUInt32LE(hashes + i * 4) : 0,
      name: cstring(buf, nameOff),
      bboxMin: [buf.readFloatLE(d + 0x30), buf.readFloatLE(d + 0x34), buf.readFloatLE(d + 0x38)],
      bboxMax: [buf.readFloatLE(d + 0x40), buf.readFloatLE(d + 0x44), buf.readFloatLE(d + 0x48)],
      models,
    });
  }
  return { drawables };
}

module.exports = { readYdd };
