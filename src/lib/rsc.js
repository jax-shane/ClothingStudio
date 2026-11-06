'use strict';
// Reader for GTA V "RSC7" resource containers (.ytd / .ydd / ...).
// A resource is a 16 byte header + one raw-deflate stream. Once inflated the
// buffer is [system segment][graphics segment]; pointers inside it use
// 0x5xxxxxxx for the system segment and 0x6xxxxxxx for the graphics segment.

const fs = require('fs');
const zlib = require('zlib');

const MAGIC = 0x37435352; // 'RSC7'

function flagsToSize(f) {
  f >>>= 0;
  const s = [
    ((f >>> 27) & 0x1) << 0,
    ((f >>> 26) & 0x1) << 1,
    ((f >>> 25) & 0x1) << 2,
    ((f >>> 24) & 0x1) << 3,
    ((f >>> 17) & 0x7f) << 4,
    ((f >>> 11) & 0x3f) << 5,
    ((f >>> 7) & 0xf) << 6,
    ((f >>> 5) & 0x3) << 7,
    ((f >>> 4) & 0x1) << 8,
  ];
  return (0x200 << (f & 0xf)) * s.reduce((a, b) => a + b, 0);
}

function loadRsc(file) {
  // already-inflated resource handed over by the archive reader: { buf, sflags, gflags }
  if (file && !Buffer.isBuffer(file) && typeof file === 'object' && file.buf) {
    return {
      version: 0, sflags: file.sflags >>> 0, gflags: file.gflags >>> 0, buf: file.buf,
      sysSize: flagsToSize(file.sflags), gfxSize: flagsToSize(file.gflags),
    };
  }
  const data = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
  if (data.length < 16 || data.readUInt32LE(0) !== MAGIC) {
    throw new Error('not an RSC7 resource (encrypted, or not a GTA V file)');
  }
  const version = data.readUInt32LE(4);
  const sflags = data.readUInt32LE(8);
  const gflags = data.readUInt32LE(12);
  const buf = zlib.inflateRawSync(data.subarray(16));
  const sysSize = flagsToSize(sflags);
  return { version, sflags, gflags, buf, sysSize, gfxSize: flagsToSize(gflags) };
}

/** Low 32 bits of the 64 bit pointer stored at `off` (high word is always 0). */
function ptrAt(buf, off) {
  return buf.readUInt32LE(off) >>> 0;
}

/** Pointer value -> absolute offset in the inflated buffer, or -1 for null/invalid. */
function resolve(rsc, ptr) {
  if (!ptr) return -1;
  const seg = ptr >>> 28;
  const off = ptr & 0x0fffffff;
  if (seg === 5) return off;
  if (seg === 6) return rsc.sysSize + off;
  return -1;
}

function cstring(buf, off, max = 128) {
  if (off < 0) return null;
  const end = buf.indexOf(0, off);
  if (end < 0 || end - off > max) return null;
  return buf.toString('latin1', off, end);
}

module.exports = { loadRsc, flagsToSize, ptrAt, resolve, cstring };
