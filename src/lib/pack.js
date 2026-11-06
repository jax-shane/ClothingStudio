'use strict';
// Scans an addon clothing resource folder (the one with fxmanifest.lua, the
// .meta files and a stream/ folder) and groups its files into paintable items:
//   gender -> component/prop -> drawable -> texture variants (a, b, ...)

const fs = require('fs');
const path = require('path');

const COMPONENTS = {
  head: 0, berd: 1, hair: 2, uppr: 3, lowr: 4, hand: 5, feet: 6, teef: 7, accs: 8, task: 9, decl: 10, jbib: 11,
};
const COMPONENT_LABEL = {
  head: 'Heads', berd: 'Masks', hair: 'Hair', uppr: 'Torsos / arms', lowr: 'Pants', hand: 'Bags / badges',
  feet: 'Shoes', teef: 'Accessories', accs: 'Undershirts', task: 'Armor / vests', decl: 'Decals', jbib: 'Tops',
};
const PROP_LABEL = {
  p_head: 'Hats', p_eyes: 'Glasses', p_ears: 'Ear items', p_mouth: 'Mouth', p_lhand: 'Left hand',
  p_rhand: 'Right hand', p_lwrist: 'Left wrist', p_rwrist: 'Right wrist', p_hip: 'Hip', p_lfoot: 'Left foot', p_rfoot: 'Right foot',
  p_ph_l_hand: 'Phone (left hand)', p_ph_r_hand: 'Phone (right hand)',
};

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function parseName(file) {
  const base = path.basename(file);
  const ext = path.extname(base).toLowerCase();
  const stem = base.slice(0, base.length - ext.length);
  const caret = stem.indexOf('^');
  if (caret < 0) return null;
  const prefix = stem.slice(0, caret);          // mp_m_freemode_01_js_gsp / mp_m_freemode_01_p_js_gsp
  const rest = stem.slice(caret + 1);           // jbib_000_u / jbib_diff_000_a_uni / p_head_000 / p_head_diff_000_a
  const pm = /^mp_([mf])_freemode_01_(p_)?(.+)$/.exec(prefix);
  if (!pm) return null;
  const gender = pm[1] === 'm' ? 'male' : 'female';
  const isProp = !!pm[2];
  const dlc = pm[3];

  if (ext === '.ydd') {
    let m = /^(p_[a-z_]+?)_(\d{3})$/.exec(rest);
    if (m) return { type: 'ydd', gender, dlc, prop: true, comp: m[1], drawable: m[2] };
    m = /^([a-z]{4})_(\d{3})_([a-z])$/.exec(rest);
    if (m && COMPONENTS[m[1]] !== undefined) return { type: 'ydd', gender, dlc, prop: false, comp: m[1], drawable: m[2], race: m[3] };
  }
  if (ext === '.ytd') {
    let m = /^(p_[a-z_]+?)_diff_(\d{3})_([a-z])$/.exec(rest);
    if (m) return { type: 'ytd', gender, dlc, prop: true, comp: m[1], drawable: m[2], letter: m[3] };
    m = /^([a-z]{4})_diff_(\d{3})_([a-z])_([a-z]{3})$/.exec(rest);
    if (m && COMPONENTS[m[1]] !== undefined) return { type: 'ytd', gender, dlc, prop: false, comp: m[1], drawable: m[2], letter: m[3], race: m[4] };
  }
  return { type: 'other', gender, dlc, isProp };
}

function readDlcName(root) {
  for (const f of fs.readdirSync(root)) {
    if (!f.toLowerCase().endsWith('.meta')) continue;
    try {
      const m = /<dlcName>([^<]+)<\/dlcName>/.exec(fs.readFileSync(path.join(root, f), 'utf8'));
      if (m) return m[1].trim();
    } catch { /* ignore */ }
  }
  return null;
}

function scanPack(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('not a folder: ' + root);
  const files = walk(root);
  // a brand new pack (made by "New pack") has a stream folder and a .meta but no pieces yet
  const looksLikeAPack = fs.existsSync(path.join(root, 'stream')) && readDlcName(root);
  if (!looksLikeAPack && !files.some((f) => /\.(ydd|ytd)$/i.test(f))) {
    throw new Error('no .ydd / .ytd files found. Drop the resource folder that contains the stream folder.');
  }

  const items = new Map();
  const ytds = [];
  for (const f of files) {
    const p = parseName(f);
    if (!p) continue;
    if (p.type === 'ydd') {
      const key = `${p.gender}|${p.comp}|${p.drawable}`;
      const it = items.get(key) || { gender: p.gender, prop: p.prop, comp: p.comp, drawable: p.drawable, variants: [] };
      it.ydd = f; it.race = p.race || null; items.set(key, it);
    } else if (p.type === 'ytd') ytds.push({ f, p });
  }
  for (const { f, p } of ytds) {
    const key = `${p.gender}|${p.comp}|${p.drawable}`;
    const it = items.get(key);
    if (it) it.variants.push({ letter: p.letter, race: p.race || null, ytd: f });
  }

  const out = [];
  for (const it of items.values()) {
    it.variants.sort((a, b) => a.letter.localeCompare(b.letter));
    const group = it.prop ? (PROP_LABEL[it.comp] || it.comp) : (COMPONENT_LABEL[it.comp] || it.comp);
    out.push({
      id: `${it.gender}_${it.comp}_${it.drawable}`,
      gender: it.gender,
      prop: it.prop,
      comp: it.comp,
      slot: it.prop ? null : COMPONENTS[it.comp],
      drawable: it.drawable,
      group,
      label: `${group.replace(/s$/, '')} ${it.drawable}`,
      ydd: it.ydd || null,
      race: it.race || null,                         // 'r' = race specific (has skin), 'u' = universal; null for props
      variants: it.variants,
    });
  }
  out.sort((a, b) => a.gender.localeCompare(b.gender) || a.group.localeCompare(b.group) || a.drawable.localeCompare(b.drawable));

  return { root, name: path.basename(root), dlcName: readDlcName(root), items: out };
}

module.exports = { scanPack, parseName, walk };
