'use strict';
// Covers src/lib/rpfwrite.js - writing GTA V RPF7 archives. The reader in rpf.js (which reads the game's own archives)
// is the judge: whatever is written must read back with the same names, contents and resource flags, and the container
// must follow the conventions measured in the game's own clothing DLC archives.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const crypto = require('crypto');
const { writeRpf, RPF7, OPEN, BLOCK } = require('../src/lib/rpfwrite');
const { Rpf } = require('../src/lib/rpf');

class Mem { constructor(b) { this.b = b; this.size = b.length; } read(o, l) { return this.b.subarray(o, o + l); } }
const open = (bytes, name = 'test.rpf') => new Rpf(null, new Mem(bytes), 0, name, bytes.length, '');

/** a resource the way the game's files look: RSC7 header (version, page flags) + a raw deflate stream */
function resource(payload, sflags, gflags) {
  const h = Buffer.alloc(16);
  h.writeUInt32LE(0x37435352, 0); h.writeUInt32LE(((gflags >>> 28) & 15) | (((sflags >>> 28) & 15) << 4), 4);
  h.writeUInt32LE(sflags >>> 0, 8); h.writeUInt32LE(gflags >>> 0, 12);
  return Buffer.concat([h, zlib.deflateRawSync(payload)]);
}
const pathsOf = (r) => r.entries.filter((e) => e.kind !== 'dir').map((e) => e.path.slice(r.path.length + 1)).sort();
const find = (r, p) => r.entries.find((e) => e.path === r.path + '/' + p.toLowerCase());

describe('writing an archive', () => {
  const xml = Buffer.from('<?xml version="1.0"?>\n' + '<Item>dlc_test:/common/data/thing.meta</Item>\n'.repeat(60));
  const noise = crypto.randomBytes(3000);                         // does not compress: stored as it is
  const ydd = resource(Buffer.from('model data '.repeat(500)), 0xa0040800, 0x50000011);
  const ytd = resource(crypto.randomBytes(5000), 0x20000, 0xd0020007);
  const inner = writeRpf([{ path: 'mp_m_freemode_01_x/jbib_000_u.ydd', data: ydd }, { path: 'mp_m_freemode_01_x.ymt', data: resource(Buffer.from('ymt'), 0x20000, 0x20000000) }]);
  const files = [
    { path: 'content.xml', data: xml },
    { path: 'common/data/Noise.bin', data: noise },
    { path: 'common/data/empty.meta', data: Buffer.alloc(0) },
    { path: 'x64/models/cdimages/x_male.rpf', data: inner },
    { path: 'x64/models/cdimages/Z_Last.ytd', data: ytd },
  ];
  const bytes = writeRpf(files);
  const r = open(bytes);

  it('reads back with the names, kinds and contents it was given', () => {
    assert.deepEqual(pathsOf(r), ['common/data/empty.meta', 'common/data/noise.bin', 'content.xml', 'x64/models/cdimages/x_male.rpf', 'x64/models/cdimages/z_last.ytd']);
    assert.ok(r.extract(find(r, 'content.xml')).equals(xml));
    assert.ok(r.extract(find(r, 'common/data/noise.bin')).equals(noise));
    assert.equal(r.extract(find(r, 'common/data/empty.meta')).length, 0);
    assert.equal(find(r, 'x64/models/cdimages/z_last.ytd').name, 'Z_Last.ytd', 'the reader lower-cases paths, the stored name keeps its case');
    assert.equal(find(r, 'common/data/noise.bin').name, 'Noise.bin');
  });

  it('stores text deflated when that is smaller and noise as it is', () => {
    const x = find(r, 'content.xml'), n = find(r, 'common/data/noise.bin');
    assert.ok(x.size > 0 && x.size < xml.length && x.uncompressed === xml.length, 'deflated');
    assert.equal(n.size, 0, 'size 0 = stored raw');
    assert.equal(n.uncompressed, noise.length);
    assert.equal(x.encrypted, false);
  });

  it('keeps the page flags of resources in the table (they decide how the game allocates them)', () => {
    const e = find(r, 'x64/models/cdimages/z_last.ytd');
    assert.deepEqual([e.kind, e.sflags, e.gflags >>> 0, e.size], ['res', 0x20000, 0xd0020007, ytd.length]);
    const x = r.extract(e);
    assert.equal(x.sflags, 0x20000);
    assert.ok(x.buf.length === 5000);
  });

  it('a nested archive is an archive: it opens, lists and extracts', () => {
    const [child] = r.children();
    assert.equal(child.name, 'x_male.rpf');
    assert.deepEqual(pathsOf(child), ['mp_m_freemode_01_x.ymt', 'mp_m_freemode_01_x/jbib_000_u.ydd']);
    const e = find(child, 'mp_m_freemode_01_x/jbib_000_u.ydd');
    assert.deepEqual([e.sflags, e.gflags >>> 0], [0xa0040800, 0x50000011]);
    assert.equal(r.entries.find((x) => x.name === 'x_male.rpf').size, 0, 'nested archives are stored raw');
  });

  it('follows the container conventions of the game\'s own archives', () => {
    assert.equal(bytes.readUInt32LE(0), RPF7);
    assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0x37, 0x46, 0x50, 0x52], 'the magic as it appears in real files');
    assert.equal(bytes.readUInt32LE(12), OPEN, 'nothing is encrypted');
    assert.equal(r.encryption, OPEN);
    const count = bytes.readUInt32LE(4), names = bytes.readUInt32LE(8);
    assert.equal(count, r.entries.length);
    assert.equal(names % 16, 0, 'the names table is padded to 16');
    assert.equal(bytes.length % BLOCK, 0, 'the archive ends on a block');
    assert.equal(r.entries[0].kind, 'dir');
    assert.equal(r.entries[0].name, '', 'entry 0 is the unnamed root folder');
    const firstBlock = Math.ceil((16 + count * 16 + names) / BLOCK);
    const fileEntries = r.entries.filter((e) => e.kind !== 'dir').sort((a, b) => a.offset - b.offset);
    assert.equal(fileEntries[0].offset, firstBlock, 'data starts right after the table, on a block');
    let next = firstBlock;
    for (const e of fileEntries) {
      assert.equal(e.offset, next, e.name + ' follows the previous file with no gap');
      const len = e.kind === 'bin' ? (e.size === 0 ? e.uncompressed : e.size) : e.size;
      next += Math.ceil(len / BLOCK);
    }
    assert.equal(next * BLOCK, bytes.length, 'and the last block is the end');
  });

  it('every folder\'s children are contiguous and sorted by lower-case name, and the table is depth first', () => {
    for (const d of r.entries.filter((e) => e.kind === 'dir')) {
      const kids = r.entries.slice(d.index, d.index + d.count).map((e) => e.lower);
      assert.deepEqual(kids, [...kids].sort(), 'children of "' + d.name + '"');
    }
    assert.deepEqual(r.entries.map((e) => e.path.slice(r.path.length) || '/'), [
      '/', '/common', '/content.xml', '/x64', '/common/data', '/common/data/empty.meta', '/common/data/noise.bin',
      '/x64/models', '/x64/models/cdimages', '/x64/models/cdimages/x_male.rpf', '/x64/models/cdimages/z_last.ytd',
    ]);
  });
});

describe('big resources', () => {
  it('a resource of 16 MB or more is marked "big" in the table and keeps its real size in the stored header', () => {
    const big = resource(crypto.randomBytes(0x1100000), 0x20000, 0xd0020007);       // random data does not shrink: > 0xFFFFFF bytes
    assert.ok(big.length > 0xffffff);
    const bytes = writeRpf([{ path: 'big.ytd', data: big }]);
    const r = open(bytes), e = find(r, 'big.ytd');
    assert.equal(e.size, 0xffffff);
    const x = r.extract(e);
    assert.equal(x.buf.length, 0x1100000, 'the reader recovers the size from the header and inflates the payload');
    assert.deepEqual([x.sflags, x.gflags >>> 0], [0x20000, 0xd0020007]);
  });
});

describe('things it refuses', () => {
  const some = Buffer.from('x');
  it('the same name twice (names are not case sensitive), a name that is both file and folder, no data', () => {
    assert.throws(() => writeRpf([{ path: 'a/b.txt', data: some }, { path: 'A/B.TXT', data: some }]), /twice/);
    assert.throws(() => writeRpf([{ path: 'a', data: some }, { path: 'a/b.txt', data: some }]), /both a file and a folder/);
    assert.throws(() => writeRpf([{ path: 'a.txt' }]), /has no data/);
    assert.throws(() => writeRpf([{ path: '', data: some }]), /needs a name/);
  });
  it('a ".rpf" that is not an archive from this writer', () => {
    assert.throws(() => writeRpf([{ path: 'x.rpf', data: Buffer.alloc(512) }]), /not an archive/);
    assert.throws(() => writeRpf([{ path: 'x.rpf', data: Buffer.from('nope') }]), /not an archive/);
  });
  it('more names than a table can address (a file entry holds a 16 bit name offset)', () => {
    const many = [];
    for (let i = 0; i < 2000; i++) many.push({ path: `folder/${'n'.repeat(30)}_${String(i).padStart(5, '0')}.ydd`, data: some });
    assert.throws(() => writeRpf(many), /too many files/);
  });
  it('an empty archive is still an archive', () => {
    const r = open(writeRpf([]));
    assert.equal(r.entries.length, 1);
    assert.deepEqual(pathsOf(r), []);
  });
});
