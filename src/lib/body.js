'use strict';
// Builds the default freemode "mannequin" (head, torso, legs, feet + skin textures)
// straight from the user's own GTA V installation, plus the bone transforms
// needed to seat props (hats, glasses) on it. Nothing from the game is copied
// to disk: files are read from the game's archives on demand.

const fs = require('fs');
const path = require('path');
const { loadOrFindKeys } = require('./gtakeys');
const { Crypto, openGta } = require('./rpf');
const { readYdd } = require('./ydd');
const ytd = require('./ytd');
const { readSkeleton } = require('./skeleton');

const BONES = { head: 31086, lHand: 18905, rHand: 57005, lFoot: 14201, rFoot: 52301, pelvis: 11816 };

const PARTS = [
  { comp: 'head', prefer: { male: 0, female: 21 } },
  { comp: 'uppr' },
  { comp: 'lowr' },
  { comp: 'feet' },
];

/** Look for a GTA V (legacy edition) install on any drive. */
function detectGtaDir(hint) {
  const tails = [
    'SteamLibrary\\steamapps\\common\\Grand Theft Auto V', 'Steam\\steamapps\\common\\Grand Theft Auto V',
    'Program Files (x86)\\Steam\\steamapps\\common\\Grand Theft Auto V', 'Program Files\\Steam\\steamapps\\common\\Grand Theft Auto V',
    'Program Files\\Rockstar Games\\Grand Theft Auto V', 'Program Files (x86)\\Rockstar Games\\Grand Theft Auto V',
    'Games\\Grand Theft Auto V', 'Epic Games\\GTAV', 'Program Files\\Epic Games\\GTAV', 'Grand Theft Auto V',
  ];
  const cands = [];
  if (hint) cands.push(hint);
  for (let c = 67; c <= 90; c++) for (const t of tails) cands.push(String.fromCharCode(c) + ':\\' + t);
  for (const d of cands) {
    try { if (fs.existsSync(path.join(d, 'GTA5.exe')) && fs.existsSync(path.join(d, 'x64a.rpf'))) return d; } catch { /* next */ }
  }
  return null;
}

// ---- quaternion helpers (x, y, z, w)
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qrot = (q, v) => {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
};

/** Bind-pose position/rotation of the bones props attach to, in model space. */
function boneTransforms(skel) {
  const byIdx = new Map(skel.bones.map((b) => [b.index, b]));
  const abs = new Map();
  const get = (b) => {
    if (abs.has(b.index)) return abs.get(b.index);
    const p = b.parent >= 0 ? byIdx.get(b.parent) : null;
    let r;
    if (!p) r = { rot: b.local.rot, pos: b.local.trans };
    else {
      const pa = get(p);
      r = { rot: qmul(pa.rot, b.local.rot), pos: qrot(pa.rot, b.local.trans).map((v, i) => v + pa.pos[i]) };
    }
    abs.set(b.index, r);
    return r;
  };
  const out = {};
  for (const [key, tag] of Object.entries(BONES)) {
    const b = skel.bones.find((x) => x.tag === tag);
    if (b) out[key] = get(b);
  }
  return out;
}

class BodySource {
  constructor(gtaDir, keyCacheFile) {
    this.gtaDir = gtaDir;
    this.keyCacheFile = keyCacheFile;
    this.peds = null;
    this.cache = new Map();
  }

  open(progress = () => {}) {
    if (this.peds) return;
    const exe = path.join(this.gtaDir, 'GTA5.exe');
    if (!fs.existsSync(exe)) throw new Error('GTA5.exe was not found in ' + this.gtaDir + ' (only the legacy edition is supported).');
    progress('Reading GTA V keys…');
    const crypto = new Crypto(loadOrFindKeys(exe, this.keyCacheFile));
    progress('Opening game archives…');
    const roots = openGta(this.gtaDir, crypto);
    if (!roots.length) throw new Error('Could not open any GTA V archive. Is this the right folder?');
    const x64v = roots.find((r) => r.name.toLowerCase() === 'x64v.rpf') || roots.find((r) => /x64[a-z]\.rpf/i.test(r.name));
    const find = (rpf, depth) => {
      for (const c of rpf.children()) {
        if (c.entries.some((e) => e.kind === 'dir' && e.lower === 'mp_m_freemode_01')) return c;
        if (depth < 4) { const r = find(c, depth + 1); if (r) return r; }
      }
      return null;
    };
    progress('Locating freemode models…');
    this.peds = (x64v && find(x64v, 0)) || roots.map((r) => find(r, 0)).find(Boolean);
    if (!this.peds) throw new Error('The freemode ped archive was not found in this install.');
  }

  entriesFor(gender) {
    const folder = `mp_${gender === 'male' ? 'm' : 'f'}_freemode_01`;
    const map = new Map();
    for (const e of this.peds.entries) {
      if (e.kind === 'dir') continue;
      const i = e.path.lastIndexOf('/');
      if (e.path.slice(0, i).endsWith('/' + folder)) map.set(e.lower, e);
    }
    return { folder, map };
  }

  load(gender, progress = () => {}) {
    if (this.cache.has(gender)) return this.cache.get(gender);
    this.open(progress);
    const { folder, map } = this.entriesFor(gender);
    const get = (name) => { const e = map.get(name.toLowerCase()); return e ? this.peds.extract(e) : null; };

    progress('Reading skeleton…');
    const yft = this.peds.entries.find((e) => e.lower === folder + '.yft');
    const bones = yft ? boneTransforms(readSkeleton(this.peds.extract(yft))) : {};

    // For each body slot use the lowest-numbered drawable (the plain default) and
    // its first skin-tone texture, whatever the exact file names are.
    const names = [...map.keys()];
    const parts = [];
    for (const spec of PARTS) {
      progress(`Reading ${spec.comp}…`);
      const re = new RegExp(`^${spec.comp}_(\\d{3})_[a-z]\\.ydd$`);
      const all = names.filter((n) => re.test(n)).sort();
      // heads: freemode blends parent shapes at runtime; 0-20 are the male parents, 21-41 the female ones
      const want = spec.prefer ? String(spec.prefer[gender]).padStart(3, '0') : null;
      const yddName = (want && all.find((n) => re.exec(n)[1] === want)) || all[0];
      if (!yddName) continue;
      const num = re.exec(yddName)[1];
      const drawable = readYdd(get(yddName)).drawables[0];
      let texture = null;
      const skin = (n) => /^[a-z]{4}_diff_\d{3}_a_[a-z]{3}\.ytd$/.test(n) && n.startsWith(spec.comp + '_diff_');
      const byNum = names.filter((n) => skin(n) && n.includes(`_diff_${num}_a_`));
      const ytdName = (byNum.length ? byNum : names.filter(skin).sort()).sort((a, b) => (/_whi\./.test(b) - /_whi\./.test(a)))[0];
      if (ytdName) {
        const t = ytd.decodeTexture(ytd.readYtd(get(ytdName)), 0);
        texture = { width: t.width, height: t.height, rgba: t.rgba };
      }
      parts.push({ comp: spec.comp, drawable: { models: [drawable.models[0]] }, texture });
    }
    if (!parts.length) throw new Error('No body parts could be read for ' + gender + '.');
    const result = { gender, parts, bones };
    this.cache.set(gender, result);
    return result;
  }
}

module.exports = { BodySource, detectGtaDir, BONES };
