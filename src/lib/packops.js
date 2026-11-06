'use strict';
// Editing the pieces of a clothing resource on disk: delete / move / add pieces and textures, make a new pack,
// build a clean FiveM resource. Every operation keeps the .ydd/.ytd files and the .ymt in step, works out the
// whole plan (and builds the new .ymt in memory) before touching a file, and rolls the renames back if something
// fails half way. Nothing is deleted for good: removed files go through the `trash` function the caller passes
// (the app gives it the Recycle Bin).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanPack, walk } = require('./pack');
const ytd = require('./ytd');
const Y = require('./ymt');
const C = require('./creature');
const OPT = require('./options');

const ASSETS = path.join(__dirname, 'assets');
const PED = { male: 'mp_m_freemode_01', female: 'mp_f_freemode_01' };
const GL = { male: 'm', female: 'f' };
const GENDERS = ['male', 'female'];
const MAX_TEX = 26;                                   // letters a-z

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const num3 = (n) => String(n).padStart(3, '0');
const slotOf = (prop, comp) => (prop ? Y.PROP_SLOT[comp] : Y.COMP_SLOT[comp]);
const base = (f) => path.basename(f);

// ------------------------------------------------------------------ names
const filePrefix = (gender, prop, dlc) => `${PED[gender]}${prop ? '_p' : ''}_${dlc}^`;
const yddFile = (g, prop, dlc, comp, n, skin) => `${filePrefix(g, prop, dlc)}${comp}_${num3(n)}${prop ? '' : skin ? '_r' : '_u'}.ydd`;
const ytdFile = (g, prop, dlc, comp, n, letter, skin) => `${filePrefix(g, prop, dlc)}${comp}_diff_${num3(n)}_${letter}${prop ? '' : skin ? '_whi' : '_uni'}.ytd`;
const letterOf = (i) => String.fromCharCode(97 + i);

/** Guess what a .ydd is from its file name; null where the name does not say (the app then asks). */
function guessYdd(file) {
  const m = /^(?:mp_([mf])_freemode_01_(p_)?[^^]*\^)?(p_[a-z_]+?|[a-z]{4})_(\d{3})(?:_([ru]))?(?:_1)?\.ydd$/i.exec(base(file));
  const out = { name: base(file), gender: null, prop: null, comp: null, hasSkin: null };
  if (!m) return out;
  const comp = m[3].toLowerCase(), prop = comp.startsWith('p_');
  if (slotOf(prop, comp) === undefined) return out;
  out.comp = comp; out.prop = prop;
  out.gender = m[1] ? (m[1].toLowerCase() === 'm' ? 'male' : 'female') : null;
  out.hasSkin = prop ? false : (m[5] ? m[5].toLowerCase() === 'r' : null);
  return out;
}

// ------------------------------------------------------------------ small helpers
const JOURNAL = '.cs_journal.json';
const inside = (root, p) => { const rel = path.relative(path.resolve(root), path.resolve(p)); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

/**
 * Every rename / new file of an operation is written to <pack>/.cs_journal.json as it happens, so if the app or the PC
 * dies half way, opening the pack again (recoverPack) puts everything back. clear() = the operation finished.
 */
class Journal {
  constructor(root) { this.done = []; this.file = root ? path.join(root, JOURNAL) : null; }
  save() { if (this.file) { try { fs.writeFileSync(this.file, JSON.stringify(this.done)); } catch { /* the journal is a safety net only */ } } }
  rename(a, b) {
    if (fs.existsSync(b)) throw new Error('Cannot rename to ' + base(b) + ': a file with that name already exists.');
    fs.renameSync(a, b); this.done.push(['mv', a, b]); this.save();
  }
  created(f) { this.done.push(['new', f]); this.save(); }
  rollback() {
    for (const [k, a, b] of [...this.done].reverse()) {
      try { if (k === 'mv') fs.renameSync(b, a); else fs.unlinkSync(a); } catch { /* best effort */ }
    }
    this.clear();
  }
  clear() { this.done = []; if (this.file) { try { fs.unlinkSync(this.file); } catch { /* none */ } } }
}

function groupItems(pack, gender, prop, comp) {
  return pack.items.filter((i) => i.gender === gender && !!i.prop === !!prop && i.comp === comp).sort((a, b) => +a.drawable - +b.drawable);
}
function checkContiguous(items, what) {
  items.forEach((it, i) => {
    if (+it.drawable !== i) throw new Error(`The numbering of ${what} has a gap (${items.map((x) => x.drawable).join(', ')}). Fix the file names first; the .ymt stores pieces by position.`);
  });
}

/** every file that belongs to one piece: its .ydd (+ cloth .yld, first-person _1.ydd) and all its textures (+ .bak) */
function familyFiles(root, item) {
  const pre = /^(.*\^)/.exec(base(item.ydd))[1];
  const re = new RegExp(`^${esc(pre)}${esc(item.comp)}(?:_diff)?_${num3(+item.drawable)}(?:_[^.]*)?\\.(?:ydd|ytd|yld)(?:\\.bak)?$`, 'i');
  return walk(root).filter((f) => re.test(base(f)));
}
const renumberName = (name, comp, n) => name.replace(new RegExp(`^(.*\\^${esc(comp)}(?:_diff)?_)(\\d{3})(?=[_.])`), (_m, a) => a + num3(n));

/** The ped variation .ymt of one gender (inside stream/): the one named after the dlc, else any mp_x_freemode_01_*.ymt. */
function findYmt(root, dlc, gender) {
  const stream = path.join(root, 'stream');
  const all = walk(fs.existsSync(stream) ? stream : root).filter((f) => /\.ymt$/i.test(f));
  const exact = dlc && all.find((f) => base(f).toLowerCase() === `${PED[gender]}_${dlc}.ymt`.toLowerCase());
  return exact || all.find((f) => new RegExp(`^mp_${GL[gender]}_freemode_01_(?!.*creaturemetadata).+\\.ymt$`, 'i').test(base(f))) || null;
}

function loadYmtFor(root, pack, gender, group) {
  const file = findYmt(root, pack.dlcName, gender);
  if (!file) return null;
  const model = Y.readYmt(file);
  for (const it of group) if (!Y.locate(model, it)) throw new Error(`${base(file)} does not list ${it.label}, so it cannot be changed safely. Use the .ymt chip to check it first.`);
  return { file, model };
}

/**
 * Files that list pieces by number and that this app does not rewrite: the first-person / alternate-variation metas.
 * (The creature metadata for heels / hair scale IS kept up to date - see planCreature.)
 */
function numberedExtras(root) {
  const out = [];
  for (const f of walk(root)) {
    const n = base(f).toLowerCase();
    if (/^first_person_alternates_.*\.meta$/.test(n) || /^pedalternativevariations_.*\.meta$/.test(n)) out.push(base(f));
  }
  return out;
}

// ------------------------------------------------------------------ creature metadata (heels / hair scale)
function creatureFile(root, dlc, gender) {
  const stream = path.join(root, 'stream');
  const all = walk(fs.existsSync(stream) ? stream : root).filter((f) => /^mp_creaturemetadata_.*\.ymt$/i.test(base(f)));
  const exact = dlc && all.find((f) => base(f).toLowerCase() === `mp_creaturemetadata_${GL[gender]}_${dlc}.ymt`.toLowerCase());
  return exact || all.find((f) => new RegExp(`^mp_creaturemetadata_${GL[gender]}_`, 'i').test(base(f))) || null;
}

/**
 * What the creature metadata of one gender should look like for this .ymt model: entries for every hat when any hat uses
 * hair scale, for every shoe when any shoe uses heels (grzyClothTool's rule). Returns null when nothing changes.
 */
function planCreature(root, dlc, gender, ymtModel) {
  const file = creatureFile(root, dlc, gender);
  let tree;
  try { tree = file ? C.readCreature(file) : C.emptyCreature(); } catch { return { skipped: `${base(file)} could not be read, so it was left as it is` }; }
  C.sync(tree, Y.creatureNeeds(ymtModel));
  if (C.isEmpty(tree)) return file ? { file, remove: true } : null;
  const bytes = C.toBuffer(tree);
  if (file && fs.readFileSync(file).equals(bytes)) return null;
  return { file: file || path.join(root, 'stream', `mp_creaturemetadata_${GL[gender]}_${dlc}.ymt`), bytes, created: !file };
}

/** write (or remove) the planned creature file; the original is kept once as .bak. Problems become warnings, never failures. */
function commitCreature(plan, J, warnings) {
  if (!plan) return;
  if (plan.skipped) { warnings.push(plan.skipped); return; }
  try {
    const bak = plan.file + '.bak';
    if (fs.existsSync(plan.file) && !fs.existsSync(bak)) fs.copyFileSync(plan.file, bak);
    if (plan.remove) { fs.unlinkSync(plan.file); return; }
    if (plan.created && J) J.created(plan.file);
    fs.mkdirSync(path.dirname(plan.file), { recursive: true });
    const tmp = plan.file + '.tmp';
    fs.writeFileSync(tmp, plan.bytes); fs.renameSync(tmp, plan.file);
  } catch (e) { warnings.push(`${base(plan.file)} could not be updated: ${e.message || e}`); }
}

// ------------------------------------------------------------------ delete / move
async function deletePiece(root, itemId, io = {}) {
  const pack = scanPack(root);
  const item = pack.items.find((i) => i.id === itemId);
  if (!item) throw new Error('That piece is not in the pack any more.');
  const group = groupItems(pack, item.gender, item.prop, item.comp);
  checkContiguous(group, `${item.gender} ${item.group}`);
  const n = +item.drawable, slot = slotOf(item.prop, item.comp);

  let ymtPlan = null;
  const y = loadYmtFor(root, pack, item.gender, group);
  let crPlan = null;
  const warns = [];
  if (y) { Y.removeDrawable(y.model, !!item.prop, slot, n); ymtPlan = { file: y.file, bytes: Y.prepareYmt(y.model) }; crPlan = planCreature(root, pack.dlcName, item.gender, y.model); }

  const doomed = familyFiles(root, item);
  const moves = [];
  for (const it of group.slice(n + 1)) for (const f of familyFiles(root, it)) moves.push({ from: f, to: path.join(path.dirname(f), renumberName(base(f), it.comp, +it.drawable - 1)) });

  // The doomed files go to the Recycle Bin under their real name and place (so "Restore" puts them back where they
  // were). Copies are kept in a temp folder until everything succeeded, so a failure further on can undo it.
  const trash = io.trash || ((f) => fs.promises.unlink(f));
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs_del_'));
  const backups = doomed.map((f, i) => ({ f, b: path.join(backupDir, i + '_' + base(f)) }));
  for (const { f, b } of backups) fs.copyFileSync(f, b);
  const J = new Journal(root), renames = [];
  const dropBackup = () => { try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* temp folder, harmless */ } };
  try {
    for (const { f } of backups) await trash(f);
    for (const m of moves) { J.rename(m.from, m.to); renames.push(m); }          // ascending, so every target was just freed
    commitCreature(crPlan, J, warns);
    if (ymtPlan) Y.commitYmt(ymtPlan.file, ymtPlan.bytes);
  } catch (e) {
    J.rollback();
    for (const { f, b } of backups) if (!fs.existsSync(f)) { try { fs.copyFileSync(b, f); } catch { /* the copy in the Recycle Bin remains */ } }
    dropBackup();
    throw e;
  }
  J.clear();
  dropBackup();
  return { renames, deleted: doomed, ymt: ymtPlan ? base(ymtPlan.file) : null, warnings: [...numberedExtras(root), ...warns] };
}

/**
 * Opening a pack after the app or the PC died in the middle of an operation: undo whatever the journal recorded
 * (renames back, half-made new files removed), then put back stray *.cs_mv files whose name is free.
 * Returns what it did, for a message.
 */
function recoverPack(root) {
  const out = { rolledBack: 0, restored: [], stuck: [] };
  const jf = path.join(root, JOURNAL);
  if (fs.existsSync(jf)) {
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch { /* unreadable: nothing to undo */ }
    for (const [k, a, b] of Array.isArray(entries) ? entries.reverse() : []) {
      try {
        if (k === 'mv' && inside(root, a) && inside(root, b) && fs.existsSync(b) && !fs.existsSync(a)) { fs.renameSync(b, a); out.rolledBack += 1; }
        else if (k === 'new' && inside(root, a) && fs.existsSync(a)) { fs.unlinkSync(a); out.rolledBack += 1; }
      } catch { /* leave it */ }
    }
    try { fs.unlinkSync(jf); } catch { /* ignore */ }
  }
  for (const f of walk(root)) {
    if (!/\.cs_mv$/i.test(f)) continue;
    const orig = f.replace(/\.cs_mv$/i, '');
    if (!fs.existsSync(orig)) { try { fs.renameSync(f, orig); out.restored.push(base(orig)); continue; } catch { /* fall through */ } }
    out.stuck.push(base(f));
  }
  return out;
}

/** Move a piece to another number; the pieces in between shift by one (moving 002 to 001 swaps them). */
function movePiece(root, itemId, toNumber) {
  const pack = scanPack(root);
  const item = pack.items.find((i) => i.id === itemId);
  if (!item) throw new Error('That piece is not in the pack any more.');
  const group = groupItems(pack, item.gender, item.prop, item.comp);
  checkContiguous(group, `${item.gender} ${item.group}`);
  const from = +item.drawable, to = toNumber, slot = slotOf(item.prop, item.comp);
  if (to < 0 || to >= group.length) throw new Error('There is no position ' + num3(to) + ' to move to.');
  if (to === from) return { renames: [], warnings: [] };
  const shift = (k) => (k === from ? to : from < to ? (k > from && k <= to ? k - 1 : k) : (k >= to && k < from ? k + 1 : k));

  let ymtPlan = null;
  const y = loadYmtFor(root, pack, item.gender, group);
  let crPlan = null;
  const warns = [];
  if (y) { Y.moveDrawable(y.model, !!item.prop, slot, from, to); ymtPlan = { file: y.file, bytes: Y.prepareYmt(y.model) }; crPlan = planCreature(root, pack.dlcName, item.gender, y.model); }

  const plan = [];
  for (const it of group) {
    const k = +it.drawable, nk = shift(k);
    if (nk === k) continue;
    for (const f of familyFiles(root, it)) plan.push({ from: f, tmp: f + '.cs_mv', to: path.join(path.dirname(f), renumberName(base(f), it.comp, nk)) });
  }
  const J = new Journal(root);
  try {
    for (const p of plan) J.rename(p.from, p.tmp);                               // park everything first, then place
    for (const p of plan) J.rename(p.tmp, p.to);
    commitCreature(crPlan, J, warns);
    if (ymtPlan) Y.commitYmt(ymtPlan.file, ymtPlan.bytes);
  } catch (e) { J.rollback(); throw e; }
  J.clear();
  return { renames: plan.map((p) => ({ from: p.from, to: p.to })), ymt: ymtPlan ? base(ymtPlan.file) : null, warnings: [...numberedExtras(root), ...warns] };
}

// ------------------------------------------------------------------ piece options (audio, flags, render flag, hair scale, heels, skin)
const optionLists = () => ({ flags: OPT.DRAWABLE_FLAGS, renderFlags: OPT.RENDER_FLAGS.map(([n]) => n) });

function getPieceOptions(root, itemId) {
  const pack = scanPack(root);
  const item = pack.items.find((i) => i.id === itemId);
  if (!item) throw new Error('That piece is not in the pack any more.');
  const file = findYmt(root, pack.dlcName, item.gender);
  if (!file) throw new Error(`This pack has no ${item.gender} .ymt, so there are no options to edit.`);
  const options = Y.getOptions(Y.readYmt(file), item);
  if (!options) throw new Error(`${base(file)} does not list ${item.label}. Use the .ymt chip to add it first.`);
  return { options, label: item.label, gender: item.gender, comp: item.comp, prop: !!item.prop, audioList: OPT.audioList(!!item.prop, item.comp), ...optionLists() };
}

const skinName = (name, skin) => name
  .replace(/^(.*\^[a-z]{4}_\d{3})_[ur](?=[_.])/i, `$1_${skin ? 'r' : 'u'}`)        // model, cloth, first-person alternate
  .replace(/_(?:uni|whi)(?=\.ytd)/i, skin ? '_whi' : '_uni');                       // textures (and their .bak)

/**
 * opts: any of { audio, flags, renderFlag, hairScale:{enabled,value}, heels:{enabled,value}, hasSkin }.
 * "Shows skin" also renames the files (_u/_uni <-> _r/_whi). Hair scale / heels keep the creature metadata in step.
 */
function setPieceOptions(root, itemId, opts) {
  const pack = scanPack(root);
  const item = pack.items.find((i) => i.id === itemId);
  if (!item) throw new Error('That piece is not in the pack any more.');
  const group = groupItems(pack, item.gender, item.prop, item.comp);
  const y = loadYmtFor(root, pack, item.gender, group);
  if (!y) throw new Error(`This pack has no ${item.gender} .ymt, so there are no options to edit.`);
  const before = Y.getOptions(y.model, item);
  const o = { ...opts };
  if (item.prop) delete o.hasSkin;
  if (o.hasSkin !== undefined && !!o.hasSkin === !!before.hasSkin) delete o.hasSkin;
  Y.setOptions(y.model, item, o);
  const ymtBytes = Y.prepareYmt(y.model);
  const crPlan = planCreature(root, pack.dlcName, item.gender, y.model);

  const plan = [];
  if (o.hasSkin !== undefined) {
    for (const f of familyFiles(root, item)) {
      const to = path.join(path.dirname(f), skinName(base(f), o.hasSkin));
      if (to !== f) plan.push({ from: f, to });
    }
  }
  const J = new Journal(root), warns = [];
  try {
    for (const p of plan) J.rename(p.from, p.to);
    commitCreature(crPlan, J, warns);
    Y.commitYmt(y.file, ymtBytes);
  } catch (e) { J.rollback(); throw e; }
  J.clear();
  return { renames: plan, ymt: base(y.file), warnings: warns };
}

// ------------------------------------------------------------------ textures
/** A .ytd to copy the size / format from, preferring the piece's own, then the same slot, then anything. */
function findTemplate(pack, gender, prop, comp, item) {
  const cands = [];
  const push = (it) => { if (it && it.variants) for (const v of it.variants) cands.push(v.ytd); };
  if (item) push(item);
  pack.items.filter((i) => i.gender === gender && !!i.prop === !!prop && i.comp === comp).forEach(push);
  pack.items.filter((i) => !!i.prop === !!prop && i.comp === comp).forEach(push);
  pack.items.filter((i) => !!i.prop === !!prop).forEach(push);
  pack.items.forEach(push);
  cands.push(path.join(ASSETS, 'template_blank.ytd'));
  for (const f of cands) {
    try { const t = ytd.readYtd(f).textures[0]; return { file: f, width: t.width, height: t.height, format: t.formatName }; } catch { /* next */ }
  }
  throw new Error('No texture template available.');
}

/** Write one texture file: copy an existing .ytd, or paint pixels into a copy of the template. */
function writeTexture(dest, tex, template, J) {
  if (fs.existsSync(dest)) throw new Error(base(dest) + ' already exists.');
  if (tex.kind === 'ytd') {
    ytd.readYtd(tex.path);                                                        // refuse files that are not a texture dictionary
    fs.copyFileSync(tex.path, dest, fs.constants.COPYFILE_EXCL);
    J.created(dest);
    return;
  }
  const { width, height } = template;
  let rgba;
  if (tex.kind === 'png') {
    rgba = Buffer.from(tex.rgba.buffer, tex.rgba.byteOffset, tex.rgba.byteLength);
    if (rgba.length !== width * height * 4) throw new Error(`The image must be ${width}×${height} pixels for this piece (it was ${tex.width}×${tex.height}).`);
  } else {                                                                        // blank: neutral grey
    rgba = Buffer.alloc(width * height * 4, 0x80);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  }
  fs.writeFileSync(dest, fs.readFileSync(template.file));
  J.created(dest);
  ytd.patchTexture(dest, 0, rgba, { backup: false });
}

/** Add textures (next letters) to an existing piece. textures: [{kind:'ytd',path}|{kind:'png',rgba,width,height}|{kind:'blank'}] */
function addTextures(root, itemId, textures) {
  const pack = scanPack(root);
  const item = pack.items.find((i) => i.id === itemId);
  if (!item) throw new Error('That piece is not in the pack any more.');
  if (item.variants.length + textures.length > MAX_TEX) throw new Error(`A piece can have at most ${MAX_TEX} textures (a-z).`);
  const template = findTemplate(pack, item.gender, item.prop, item.comp, item);
  const skin = (item.race || 'u').toLowerCase() === 'r';
  const dir = path.dirname(item.variants[0] ? item.variants[0].ytd : item.ydd);
  const J = new Journal(root), made = [];
  const top = Math.max(...item.variants.map((v) => v.letter.charCodeAt(0) - 97));   // next after the highest letter, even if one is missing
  if (top + textures.length >= MAX_TEX) throw new Error(`There is no room for ${textures.length} more texture(s) after "${letterOf(top)}" (a-z only).`);
  try {
    textures.forEach((t, i) => {
      const letter = letterOf(top + 1 + i);
      const dest = path.join(dir, ytdFile(item.gender, item.prop, pack.dlcName, item.comp, +item.drawable, letter, skin));
      writeTexture(dest, t, template, J); made.push(dest);
    });
    const after = scanPack(root);
    const y = loadYmtFor(root, after, item.gender, after.items.filter((i) => i.id === itemId));
    if (y) { Y.applyCounts(y.model, after.items.filter((i) => i.gender === item.gender), itemId); Y.writeYmt(y.file, y.model); }
  } catch (e) { J.rollback(); throw e; }
  J.clear();
  return { files: made, id: itemId };
}

// ------------------------------------------------------------------ add a piece
/**
 * spec: { gender, prop, comp, hasSkin, ydd: path, textures: [...] } -> { id, number, files }
 * The new piece gets the next free number of its slot, files named the way FiveM expects, and a .ymt entry.
 */
function addPiece(root, spec) {
  const pack = scanPack(root);
  if (!pack.dlcName) throw new Error('This pack has no <dlcName> in its .meta file, so the file names cannot be built.');
  if (!GENDERS.includes(spec.gender)) throw new Error('Choose male or female.');
  const slot = slotOf(spec.prop, spec.comp);
  if (slot === undefined) throw new Error('Choose what kind of piece this is.');
  if (!spec.textures || !spec.textures.length) throw new Error('A piece needs at least one texture.');
  if (spec.textures.length > MAX_TEX) throw new Error(`A piece can have at most ${MAX_TEX} textures.`);
  const group = groupItems(pack, spec.gender, spec.prop, spec.comp);
  checkContiguous(group, `${spec.gender} ${spec.comp}`);
  const number = group.length;
  if (number > 255) throw new Error('This slot is full (000-255).');
  const skin = !spec.prop && !!spec.hasSkin;

  const template = findTemplate(pack, spec.gender, spec.prop, spec.comp, null);
  const sibling = group[0];
  const dir = sibling ? path.dirname(sibling.ydd) : path.join(root, 'stream', `[${spec.gender}]`, spec.comp);
  const dest = path.join(dir, yddFile(spec.gender, spec.prop, pack.dlcName, spec.comp, number, skin));
  if (fs.existsSync(dest)) throw new Error(base(dest) + ' already exists.');

  let ymtPlan = null;
  const y = loadYmtFor(root, pack, spec.gender, group);
  let crPlan = null;
  const warns = [];
  if (y) {
    Y.insertDrawable(y.model, !!spec.prop, slot, number, { hasSkin: skin, texCount: spec.textures.length });
    ymtPlan = { file: y.file, bytes: Y.prepareYmt(y.model) };
    crPlan = planCreature(root, pack.dlcName, spec.gender, y.model);       // a new hat / shoe joins the others' hair scale / heels entries
  }

  const J = new Journal(root), files = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(spec.ydd, dest, fs.constants.COPYFILE_EXCL); J.created(dest); files.push(dest);
    const yldSrc = spec.ydd.replace(/\.ydd$/i, '.yld');                         // cloth physics next to the drawable
    if (fs.existsSync(yldSrc)) { const yd = dest.replace(/\.ydd$/i, '.yld'); fs.copyFileSync(yldSrc, yd, fs.constants.COPYFILE_EXCL); J.created(yd); files.push(yd); }
    spec.textures.forEach((t, i) => {
      const f = path.join(dir, ytdFile(spec.gender, spec.prop, pack.dlcName, spec.comp, number, letterOf(i), skin));
      writeTexture(f, t, template, J); files.push(f);
    });
    commitCreature(crPlan, J, warns);
    if (ymtPlan) Y.commitYmt(ymtPlan.file, ymtPlan.bytes);
  } catch (e) { J.rollback(); throw e; }
  J.clear();
  return { id: `${spec.gender}_${spec.comp}_${num3(number)}`, number, files, ymt: ymtPlan ? base(ymtPlan.file) : null, warnings: warns };
}

// ------------------------------------------------------------------ new pack / build
const MANIFEST_NOTE = '-- This resource was generated by ClothingStudio (layout by grzyClothTool)';

function metaXml(gender, dlc) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ShopPedApparel>
    <pedName>${PED[gender]}</pedName>
    <dlcName>${dlc}</dlcName>
    <fullDlcName>${PED[gender]}_${dlc}</fullDlcName>
    <eCharacter>${gender === 'male' ? 'SCR_CHAR_MULTIPLAYER' : 'SCR_CHAR_MULTIPLAYER_F'}</eCharacter>
    <creatureMetaData>mp_creaturemetadata_${GL[gender]}_${dlc}</creatureMetaData>
    <pedOutfits>
    </pedOutfits>
    <pedComponents>
    </pedComponents>
    <pedProps>
    </pedProps>
</ShopPedApparel>
`;
}

function manifestLua(metaFiles, extra) {
  const files = [...metaFiles, ...extra.map((e) => e.file)];
  return `${MANIFEST_NOTE}

fx_version 'cerulean'
game 'gta5'
author 'ClothingStudio'

files {
  ${files.map((f) => `'${f}'`).join(',\n  ')}
}

${metaFiles.map((f) => `data_file 'SHOP_PED_APPAREL_META_FILE' '${f}'`).join('\n')}
${extra.map((e) => `data_file '${e.type}' '${e.file}'`).join('\n')}
`.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

const validName = (n) => /^[A-Za-z0-9_]{1,40}$/.test(n || '');

/** Empty resource: manifest, both .meta files, empty .ymt + creature metadata for each gender, stream folder. */
function writeScaffold(dir, dlc) {
  fs.mkdirSync(path.join(dir, 'stream'), { recursive: true });
  const metas = [];
  for (const g of GENDERS) {
    const metaName = `${PED[g]}_${dlc}.meta`;
    fs.writeFileSync(path.join(dir, metaName), metaXml(g, dlc), 'utf8');
    metas.push(metaName);
    fs.writeFileSync(path.join(dir, 'stream', `${PED[g]}_${dlc}.ymt`), Y.prepareYmt(Y.createModel(dlc)));
    // no creature metadata yet: it only exists once a hat uses hair scale or a shoe uses heels (like grzyClothTool)
  }
  fs.writeFileSync(path.join(dir, 'fxmanifest.lua'), manifestLua(metas, []), 'utf8');
}

function createPack(parentDir, name) {
  if (!validName(name)) throw new Error('Use letters, digits and underscores only (for example my_clothes), up to 40 characters.');
  const dir = path.join(parentDir, name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(dir + ' already exists and is not empty.');
  writeScaffold(dir, name);
  return { root: dir };
}

/**
 * Write a clean, self-consistent FiveM resource of the open pack into outDir (which must be empty or new),
 * optionally under a new name. The .ymt of each gender is rebuilt from the original (so audio / flags / heel settings
 * survive) with every piece that has files listed and every texture count matching.
 */
function buildResource(root, outDir, newName) {
  const pack = scanPack(root);
  const oldDlc = pack.dlcName;
  if (!oldDlc) throw new Error('This pack has no <dlcName> in its .meta file.');
  const dlc = newName || oldDlc;
  if (!validName(dlc)) throw new Error('Use letters, digits and underscores only for the resource name.');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error('The output folder is not empty: ' + outDir);
  const outRoot = path.resolve(outDir).toLowerCase(), inRoot = path.resolve(root).toLowerCase();    // Windows paths are not case sensitive
  if (outRoot === inRoot || outRoot.startsWith(inRoot + path.sep)) throw new Error('Choose a folder outside the pack you are building from.');

  const rename = (name) => name.split(`_${oldDlc}^`).join(`_${dlc}^`).split(`_${oldDlc}.`).join(`_${dlc}.`);
  const report = { files: 0, ymt: [], notes: [] };

  // everything is built in a work folder next to the target and moved into place at the end, so a failure part way
  // never leaves a half-built resource behind that would block the next try
  const work = outDir + '.cs_building';
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'stream'), { recursive: true });
  try {
    // 1. the .ymt per gender first (so a problem shows up before any file is copied) + creature metadata + .meta
    const metas = [], skipYmt = new Set();
    for (const g of GENDERS) {
      const items = pack.items.filter((i) => i.gender === g);
      const src = findYmt(root, oldDlc, g);
      if (!items.length && !src) continue;
      const model = src ? Y.readYmt(src) : Y.createModel(dlc);
      // list every piece that has files, then make the texture counts match
      for (const it of Y.ensureListed(model, items)) report.notes.push(`${g} ${it.label} was missing from the .ymt and was added`);
      Y.applyCounts(model, items);
      Y.setDlcName(model, dlc);
      const out = path.join(work, 'stream', `${PED[g]}_${dlc}.ymt`);
      fs.writeFileSync(out, Y.prepareYmt(model)); report.ymt.push(base(out));
      if (src) skipYmt.add(src.toLowerCase());

      // creature metadata (heels / hair scale): rebuilt to match this .ymt, written only when something needs it
      const cmSrc = creatureFile(root, oldDlc, g);
      if (cmSrc) skipYmt.add(cmSrc.toLowerCase());
      let cmTree;
      try { cmTree = cmSrc ? C.readCreature(cmSrc) : C.emptyCreature(); } catch { cmTree = null; report.notes.push(`${base(cmSrc)} could not be read and was copied as it is`); }
      if (cmTree) {
        C.sync(cmTree, Y.creatureNeeds(model));
        if (!C.isEmpty(cmTree)) fs.writeFileSync(path.join(work, 'stream', `mp_creaturemetadata_${GL[g]}_${dlc}.ymt`), C.toBuffer(cmTree));
      } else fs.writeFileSync(path.join(work, 'stream', `mp_creaturemetadata_${GL[g]}_${dlc}.ymt`), fs.readFileSync(cmSrc));

      const metaName = `${PED[g]}_${dlc}.meta`;
      fs.writeFileSync(path.join(work, metaName), metaXml(g, dlc), 'utf8');
      metas.push(metaName);
    }

    // 2. stream files (everything except backups / temp files), names carried over to the new resource name
    const skip = /(\.bak|\.tmp|\.cs_[a-z]+)$/i;
    const streamRoot = path.join(root, 'stream');
    for (const f of walk(streamRoot)) {
      const n = base(f);
      if (skip.test(n)) continue;
      if (/\.ymt$/i.test(n) && skipYmt.has(f.toLowerCase())) continue;           // rebuilt above
      if (/\.ymt$/i.test(n)) report.notes.push(`${n} is not a ped .ymt this builder knows, so it was copied as it is`);
      const to = path.join(work, 'stream', path.relative(streamRoot, path.join(path.dirname(f), rename(n))));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(f, to); report.files += 1;
    }

    // 3. first-person / alternate-variation data files: carried over, with the resource name replaced where it is a whole name part
    const extra = [], nameRe = new RegExp(`(?<=_)${esc(oldDlc)}(?![A-Za-z0-9_])`, 'g');
    for (const f of walk(root)) {
      const n = base(f).toLowerCase();
      if (inside(streamRoot, f)) continue;
      const type = /^first_person_alternates_.*\.meta$/.test(n) ? 'PED_FIRST_PERSON_ALTERNATE_DATA' : /^pedalternativevariations_.*\.meta$/.test(n) ? 'ALTERNATE_VARIATIONS_FILE' : null;
      if (!type) continue;
      const outName = rename(base(f));
      fs.writeFileSync(path.join(work, outName), fs.readFileSync(f, 'utf8').replace(nameRe, dlc), 'utf8');
      extra.push({ type, file: outName });
    }
    fs.writeFileSync(path.join(work, 'fxmanifest.lua'), manifestLua(metas, extra), 'utf8');

    if (fs.existsSync(outDir)) fs.rmdirSync(outDir);                              // an existing but empty folder
    fs.renameSync(work, outDir);
  } catch (e) {
    fs.rmSync(work, { recursive: true, force: true });
    throw e;
  }
  report.root = outDir; report.name = dlc;
  return report;
}

module.exports = {
  guessYdd, deletePiece, movePiece, addPiece, addTextures, findTemplate, createPack, buildResource, writeScaffold, validName, recoverPack,
  getPieceOptions, setPieceOptions,
  findYmt, yddFile, ytdFile, familyFiles, renumberName, numberedExtras,
};
