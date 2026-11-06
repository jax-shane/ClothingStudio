'use strict';
// Reads the bone list of a fragment (.yft) such as mp_m_freemode_01.yft.
// Used to place props (hats, glasses) on the head bone of the body mannequin.

const { loadRsc, ptrAt, resolve, cstring } = require('./rsc');

const BONE_TAG = { HEAD: 31086, SPINE3: 24818, PELVIS: 11816 };

/** @returns {{ bones: Array<{index, parent, tag, name, local:{rot,trans,scale}, bind:number[]}> }} */
function readSkeleton(file) {
  const rsc = loadRsc(file);
  const { buf } = rsc;
  const drawable = resolve(rsc, ptrAt(buf, 0x30));         // FragType.DrawablePointer
  if (drawable < 0) throw new Error('fragment has no drawable');
  const skel = resolve(rsc, ptrAt(buf, drawable + 0x18));  // DrawableBase.SkeletonPointer
  if (skel < 0) throw new Error('drawable has no skeleton');

  const count = buf.readUInt16LE(skel + 0x5e);
  const bonesAt = resolve(rsc, ptrAt(buf, skel + 0x20));
  const matsAt = resolve(rsc, ptrAt(buf, skel + 0x30));    // Transformations (bind pose, model space)
  if (bonesAt < 0 || count === 0 || count > 1024) throw new Error('unexpected skeleton layout');

  const bones = [];
  for (let i = 0; i < count; i++) {
    const o = bonesAt + i * 80;
    const f = (k) => buf.readFloatLE(o + k);
    bones.push({
      index: buf.readInt16LE(o + 0x42),
      parent: buf.readInt16LE(o + 0x32),
      tag: buf.readUInt16LE(o + 0x44),
      name: cstring(buf, resolve(rsc, ptrAt(buf, o + 0x38))),
      local: { rot: [f(0), f(4), f(8), f(12)], trans: [f(16), f(20), f(24)], scale: [f(32), f(36), f(40)] },
      bind: matsAt >= 0 ? Array.from({ length: 16 }, (_, k) => buf.readFloatLE(matsAt + i * 64 + k * 4)) : null,
    });
  }
  return { bones };
}

module.exports = { readSkeleton, BONE_TAG };
