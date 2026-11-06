'use strict';
// Reader / writer for GTA V "RBF0" files - the small binary XML used by creature metadata (.ymt heels / hair scaling).
// Layout knowledge: CodeWalker (dexyfex, GPL-3.0), RbfFile.cs, itself based on work by Neodymium (MIT).
//
//   "RBF0" then a stream of records. A record is  [descriptor index u8][data type u8] and, the first time a name is used,
//   [name length u16][name]. Types: 0x00 structure (+ 4 zero bytes + attribute count u16, attributes, children, FF FF),
//   0x10 uint32, 0x20 true, 0x30 false, 0x40 float, 0x50 float x3, 0x60 string (u16 length + text).
//   Raw byte blocks are  FD FF [length i32][bytes].
//
// Nodes:  { type: 'struct', name, attrs: [], children: [] }, { type: 'u32'|'bool'|'float'|'float3'|'string', name, value },
//         { type: 'bytes', value: Buffer }

const MAGIC = 0x30464252; // 'RBF0'

function parseRbf(buf) {
  if (buf.length < 6 || buf.readUInt32LE(0) !== MAGIC) throw new Error('not an RBF file');
  let pos = 4, current = null;
  const names = [], stack = [];
  const add = (n) => {
    if (current.pending > 0) { current.pending -= 1; current.attrs.push(n); } else current.children.push(n);
  };
  while (pos < buf.length) {
    const idx = buf[pos++];
    if (idx === 0xff) {                                             // close tag
      if (buf[pos++] !== 0xff) throw new Error('bad RBF close tag');
      if (stack.length) current = stack.pop();
      else {
        if (pos !== buf.length) throw new Error('extra data after the RBF root');
        return current;
      }
    } else if (idx === 0xfd) {                                      // raw bytes
      if (buf[pos++] !== 0xff) throw new Error('bad RBF bytes record');
      const len = buf.readInt32LE(pos); pos += 4;
      if (len < 0 || pos + len > buf.length) throw new Error('RBF bytes run past the end');
      add({ type: 'bytes', value: Buffer.from(buf.subarray(pos, pos + len)) });
      pos += len;
    } else {
      const dt = buf[pos++];
      if (idx === names.length) {
        const nl = buf.readInt16LE(pos); pos += 2;
        names.push(buf.toString('latin1', pos, pos + nl)); pos += nl;
      } else if (idx > names.length) throw new Error('RBF refers to a name it has not defined');
      const name = names[idx];
      switch (dt) {
        case 0x00: {
          const node = { type: 'struct', name, attrs: [], children: [], pending: 0 };
          if (current) { add(node); stack.push(current); }
          current = node;
          pos += 4; node.pending = buf.readInt16LE(pos); pos += 2;
          break;
        }
        case 0x10: add({ type: 'u32', name, value: buf.readUInt32LE(pos) }); pos += 4; break;
        case 0x20: add({ type: 'bool', name, value: true }); break;
        case 0x30: add({ type: 'bool', name, value: false }); break;
        case 0x40: add({ type: 'float', name, value: buf.readFloatLE(pos) }); pos += 4; break;
        case 0x50: add({ type: 'float3', name, value: [buf.readFloatLE(pos), buf.readFloatLE(pos + 4), buf.readFloatLE(pos + 8)] }); pos += 12; break;
        case 0x60: { const l = buf.readInt16LE(pos); pos += 2; add({ type: 'string', name, value: buf.toString('latin1', pos, pos + l) }); pos += l; break; }
        default: throw new Error('unsupported RBF data type 0x' + dt.toString(16));
      }
    }
  }
  throw new Error('unexpected end of RBF data');
}

function writeRbf(root) {
  const parts = [], ids = new Map();
  const put = (b) => parts.push(Buffer.isBuffer(b) ? b : Buffer.from(b));
  const record = (node, dataType) => {
    let idx = ids.get(node.name);
    const isNew = idx === undefined;
    if (isNew) { idx = ids.size; ids.set(node.name, idx); }
    put([idx & 0xff, dataType]);
    if (isNew) { const n = Buffer.from(node.name, 'latin1'); const l = Buffer.alloc(2); l.writeUInt16LE(n.length); put(l); put(n); }
  };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); put(b); };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); put(b); };
  const save = (n) => {
    switch (n.type) {
      case 'bytes': { put([0xfd, 0xff]); const l = Buffer.alloc(4); l.writeInt32LE(n.value.length); put(l); put(n.value); break; }
      case 'u32': record(n, 0x10); u32(n.value); break;
      case 'bool': record(n, n.value ? 0x20 : 0x30); break;
      case 'float': record(n, 0x40); f32(n.value); break;
      case 'float3': record(n, 0x50); n.value.forEach(f32); break;
      case 'string': { record(n, 0x60); const s = Buffer.from(n.value, 'latin1'); const l = Buffer.alloc(2); l.writeUInt16LE(s.length); put(l); put(s); break; }
      case 'struct': {
        record(n, 0x00);
        put([0, 0, 0, 0]);
        const c = Buffer.alloc(2); c.writeInt16LE(n.attrs.length); put(c);
        n.attrs.forEach(save); n.children.forEach(save);
        put([0xff, 0xff]);
        break;
      }
      default: throw new Error('cannot write RBF node type ' + n.type);
    }
  };
  const head = Buffer.alloc(4); head.writeUInt32LE(MAGIC);
  put(head); save(root);
  return Buffer.concat(parts);
}

module.exports = { parseRbf, writeRbf };
