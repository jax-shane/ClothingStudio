'use strict';
// Creature metadata (mp_creaturemetadata_<m|f>_<dlc>.ymt): the RBF file that switches on the "expressions" that make
// hair squash under a hat (hair scale) and lift the character for high heels. The values themselves live in the
// pack's ped .ymt; this file only says which pieces have the expression attached.
//
// grzyClothTool writes it like this, and so does this module: if ANY hat uses hair scale, every hat (p_head) piece gets
// an entry (plus the one dummy first entry every original game file has); if ANY pair of shoes uses high heels, every
// shoe piece gets an entry. With neither, no file is written at all.

const fs = require('fs');
const { parseRbf, writeRbf } = require('./rbf');

const NONE = 0xffffffff;
const HEEL = { id: 6, expr: 4, ids: 28462 };      // component slot 6 (feet), expression 4
const HAT = { id: 0, expr: 0, ids: 13201 };       // prop slot 0 (p_head), expression 0

const u32 = (name, value) => ({ type: 'u32', name, value: value >>> 0 });
const bytesStruct = (name, kind, bytes) => ({ type: 'struct', name, attrs: [{ type: 'string', name: 'content', value: kind }], children: [{ type: 'bytes', value: Buffer.from(bytes) }] });

function makeItem(prefix, id, varIndex, exprIndex, idsValue) {
  const label = prefix === 'comp' ? 'Comp' : 'Prop';
  return {
    type: 'struct', name: 'Item', attrs: [], children: [
      u32(`ped${label}ID`, id), u32(`ped${label}VarIndex`, varIndex), u32(`ped${label}ExpressionIndex`, exprIndex),
      bytesStruct('tracks', 'char_array', [33]),
      bytesStruct('ids', 'short_array', [idsValue & 0xff, (idsValue >> 8) & 0xff]),
      bytesStruct('types', 'char_array', [2]),
      bytesStruct('components', 'char_array', [1]),
    ],
  };
}

const field = (item, name) => { const c = item.children.find((x) => x.name === name); return c ? c.value : undefined; };

function emptyCreature() {
  return { type: 'struct', name: 'CCreatureMetaData', attrs: [], children: [
    { type: 'struct', name: 'pedCompExpressions', attrs: [], children: [] },
    { type: 'struct', name: 'pedPropExpressions', attrs: [], children: [] },
  ] };
}

function container(root, name) {
  let c = root.children.find((x) => x.name === name);
  if (!c) { c = { type: 'struct', name, attrs: [], children: [] }; root.children.push(c); }
  return c;
}

function readCreature(file) {
  const root = parseRbf(Buffer.isBuffer(file) ? file : fs.readFileSync(file));
  if (root.name !== 'CCreatureMetaData') throw new Error('not a creature metadata file');
  container(root, 'pedCompExpressions'); container(root, 'pedPropExpressions');
  return root;
}

const toBuffer = (root) => writeRbf(root);

const compItems = (root) => container(root, 'pedCompExpressions').children;
const propItems = (root) => container(root, 'pedPropExpressions').children;
const isHeel = (it) => field(it, 'pedCompID') === HEEL.id && field(it, 'pedCompExpressionIndex') === HEEL.expr;
const isHat = (it) => field(it, 'pedPropID') === HAT.id && (field(it, 'pedPropExpressionIndex') === HAT.expr || field(it, 'pedPropVarIndex') === NONE);

/** true when nothing is left in the file that matters (only the dummy first prop entry, or nothing) */
function isEmpty(root) {
  return compItems(root).length === 0 && propItems(root).every((it) => field(it, 'pedPropVarIndex') === NONE);
}

/**
 * Make the entries match the ped .ymt: heels on for any shoe piece -> an entry for every shoe piece; hair scale on for
 * any hat -> an entry for every hat (+ the dummy first one). Entries this module does not recognise are left alone.
 * `want`: { heels: <number of shoe pieces or 0 when no piece uses heels>, hats: <number of hats or 0> }
 */
function sync(root, want) {
  const comps = container(root, 'pedCompExpressions'), props = container(root, 'pedPropExpressions');
  comps.children = comps.children.filter((it) => !isHeel(it));
  for (let n = 0; n < want.heels; n++) comps.children.push(makeItem('comp', HEEL.id, n, HEEL.expr, HEEL.ids));
  comps.children.sort((a, b) => field(a, 'pedCompID') - field(b, 'pedCompID') || field(a, 'pedCompVarIndex') - field(b, 'pedCompVarIndex'));

  props.children = props.children.filter((it) => !isHat(it));
  const others = props.children;
  const mine = [];
  if (want.hats > 0) {
    mine.push(makeItem('prop', HAT.id, NONE, NONE, HAT.ids));
    for (let n = 0; n < want.hats; n++) mine.push(makeItem('prop', HAT.id, n, HAT.expr, HAT.ids));
  }
  props.children = [...mine, ...others];
  return root;
}

module.exports = { readCreature, emptyCreature, toBuffer, sync, isEmpty, field };
