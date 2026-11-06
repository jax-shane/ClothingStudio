'use strict';
// Covers src/lib/rbf.js (the "RBF0" binary XML reader / writer) and src/lib/creature.js (the creature metadata that
// makes hair squash under hats and lifts characters in high heels), including grzyClothTool's rule that ONE hat with
// hair scale gives EVERY hat an entry, ONE pair of heels gives EVERY shoe an entry, and neither gives no file at all.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseRbf, writeRbf } = require('../src/lib/rbf');
const C = require('../src/lib/creature');

const NONE = 0xffffffff;
const field = C.field;
// ids / tracks / types / components are little structs that hold one raw byte block
const bytesOf = (item, name) => [...item.children.find((x) => x.name === name).children[0].value];
const propItems = (root) => root.children.find((c) => c.name === 'pedPropExpressions').children;
const compItems = (root) => root.children.find((c) => c.name === 'pedCompExpressions').children;
// the parser leaves a bookkeeping counter on structs; drop it to compare trees with ones written by hand
const plain = (n) => JSON.parse(JSON.stringify(n, (k, v) => (k === 'pending' ? undefined : v)));

describe('RBF reader / writer', () => {
  const sample = () => ({
    type: 'struct', name: 'Root', attrs: [{ type: 'string', name: 'kind', value: 'demo' }], children: [
      { type: 'u32', name: 'count', value: 4000000000 },
      { type: 'bool', name: 'yes', value: true },
      { type: 'bool', name: 'no', value: false },
      { type: 'float', name: 'scale', value: 0.5 },
      { type: 'float3', name: 'pos', value: [1, -2, 0.25] },
      { type: 'string', name: 'label', value: 'hello' },
      { type: 'struct', name: 'Inner', attrs: [], children: [{ type: 'bytes', value: Buffer.from([1, 2, 3, 255]) }, { type: 'u32', name: 'count', value: 7 }] },
    ],
  });

  it('every node type survives write -> parse', () => {
    const back = parseRbf(writeRbf(sample()));
    assert.deepEqual(plain(back), plain(sample()));
  });

  it('write -> parse -> write is byte-identical (names are defined once, then reused)', () => {
    const bytes = writeRbf(sample());
    assert.deepEqual(writeRbf(parseRbf(bytes)), bytes);
    assert.equal(bytes.toString('latin1', 0, 4), 'RBF0');
  });

  it('refuses things that are not RBF, truncated or padded files', () => {
    assert.throws(() => parseRbf(Buffer.from('definitely not an rbf file')), /not an RBF file/);
    const good = writeRbf(sample());
    assert.throws(() => parseRbf(good.subarray(0, good.length - 4)), /RBF/);
    assert.throws(() => parseRbf(Buffer.concat([good, Buffer.from([0, 0])])), /extra data|RBF/);
  });
});

describe('creature metadata', () => {
  it('an empty file asks for nothing, and syncing "no hair scale, no heels" keeps it empty', () => {
    const t = C.emptyCreature();
    assert.equal(C.isEmpty(t), true);
    C.sync(t, { hats: 0, heels: 0 });
    assert.equal(C.isEmpty(t), true);
  });

  it('hair scale on any hat: a dummy first entry plus one entry per hat', () => {
    const t = C.sync(C.emptyCreature(), { hats: 3, heels: 0 });
    const props = propItems(t);
    assert.equal(props.length, 4, 'dummy + 3 hats');
    assert.equal(field(props[0], 'pedPropVarIndex'), NONE);
    assert.equal(field(props[0], 'pedPropExpressionIndex'), NONE);
    assert.deepEqual(props.slice(1).map((p) => field(p, 'pedPropVarIndex')), [0, 1, 2]);
    for (const p of props) {
      assert.equal(field(p, 'pedPropID'), 0, 'prop slot 0 = hats (p_head)');
      assert.deepEqual(bytesOf(p, 'ids'), [0x91, 0x33], 'ids 13201 as a little-endian short');
    }
    assert.equal(field(props[1], 'pedPropExpressionIndex'), 0);
    assert.equal(compItems(t).length, 0);
    assert.equal(C.isEmpty(t), false);
  });

  it('heels on any shoe: one entry per shoe (component 6, expression 4)', () => {
    const t = C.sync(C.emptyCreature(), { hats: 0, heels: 2 });
    const comps = compItems(t);
    assert.equal(comps.length, 2);
    comps.forEach((c, i) => {
      assert.equal(field(c, 'pedCompID'), 6);
      assert.equal(field(c, 'pedCompVarIndex'), i);
      assert.equal(field(c, 'pedCompExpressionIndex'), 4);
      assert.deepEqual(bytesOf(c, 'ids'), [0x2e, 0x6f], 'ids 28462');
      assert.deepEqual(bytesOf(c, 'tracks'), [33]);
      assert.deepEqual(bytesOf(c, 'types'), [2]);
      assert.deepEqual(bytesOf(c, 'components'), [1]);
    });
    assert.equal(propItems(t).length, 0);
  });

  it('survives write -> read and is stable when synced twice', () => {
    const t = C.sync(C.emptyCreature(), { hats: 2, heels: 3 });
    const bytes = C.toBuffer(t);
    const again = C.readCreature(bytes);
    assert.deepEqual(plain(again), plain(t));
    C.sync(again, { hats: 2, heels: 3 });
    assert.deepEqual(C.toBuffer(again), bytes, 'syncing an up-to-date file changes nothing');
  });

  it('shrinks and clears again: fewer hats, then nothing needed = empty (so no file is written)', () => {
    const t = C.sync(C.emptyCreature(), { hats: 4, heels: 4 });
    C.sync(t, { hats: 2, heels: 1 });
    assert.equal(propItems(t).length, 3);
    assert.equal(compItems(t).length, 1);
    C.sync(t, { hats: 0, heels: 0 });
    assert.equal(C.isEmpty(t), true);
  });

  it('leaves entries it does not own alone', () => {
    const t = C.emptyCreature();
    // a glasses entry (prop slot 1) and a torso entry (component 3) that some other tool put there
    const foreignProp = { type: 'struct', name: 'Item', attrs: [], children: [{ type: 'u32', name: 'pedPropID', value: 1 }, { type: 'u32', name: 'pedPropVarIndex', value: 0 }, { type: 'u32', name: 'pedPropExpressionIndex', value: 9 }] };
    const foreignComp = { type: 'struct', name: 'Item', attrs: [], children: [{ type: 'u32', name: 'pedCompID', value: 3 }, { type: 'u32', name: 'pedCompVarIndex', value: 0 }, { type: 'u32', name: 'pedCompExpressionIndex', value: 1 }] };
    t.children[0].children.push(foreignComp);
    t.children[1].children.push(foreignProp);
    C.sync(t, { hats: 2, heels: 2 });
    assert.ok(propItems(t).includes(foreignProp));
    assert.ok(compItems(t).includes(foreignComp));
    assert.equal(propItems(t)[propItems(t).length - 1], foreignProp, 'ours first, theirs after');
    C.sync(t, { hats: 0, heels: 0 });
    assert.equal(C.isEmpty(t), false, 'a foreign entry is still there, so the file is still needed');
    assert.deepEqual(propItems(t), [foreignProp]);
  });

  it('rejects an RBF that is not creature metadata', () => {
    const other = writeRbf({ type: 'struct', name: 'SomethingElse', attrs: [], children: [] });
    assert.throws(() => C.readCreature(other), /not a creature metadata file/);
  });
});
