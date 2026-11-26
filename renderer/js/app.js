import { api } from './api.js';
import { t, tn, tm, list, sentences, getLanguage, LANGUAGES, showLanguage, startLanguage, pickLanguage } from './i18n.js';
import { Viewer } from './viewer.js';
import { addPieceDialog, optionsDialog, groupText, pieceLabel } from './pieces.js';
import { growSizes, textureSizeFor, addChoices, memoryMB, mbText } from './texsize.js';
import { comboOf, shortcutMatches, digitOf } from './keys.js';
import { GRAINS, foldsMap, grainMap, bend } from './fabric.js';

const Paint = window.Paint;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const basename = (p) => String(p).split(/[\\/]/).pop();
const N_ = (s) => s;                 // N_('text') only marks a text for translation (tools/i18n.js collects it); the text is translated where it is shown

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const S = {
  pack: null,
  sel: null,                 // { item, variant, ytd, doc, preview, tex, uv }
  docs: new Map(),           // ytd path -> entry (keeps unsaved work when you switch pieces)
  meshes: new Map(),         // ydd path -> parsed mesh
  recent: [],
  zoom: 1, panX: 0, panY: 0,
  space: false, panning: null, stroking: false, altTool: null,
  busy: false,
  gta: null, bodyOn: false, body: {},   // GTA V folder, mannequin on/off, loaded body data per gender
  hsv: { h: 0, s: 0.78, v: 0.88 },      // the colour wheel's own state (hue 0-360, saturation and brightness 0-1)
  xfDrag: null,                         // an in-progress drag of the Resize tool
  pop: false, popBody: null, last: null, // pop-out 3D window: open?, which gender's body it already has, scene to (re)send
  fs: false,                            // the 3D panel is full screen
  collapsed: new Set(), filter: '',     // the Pack list: closed Male / Female / category sections, and the filter text
  text: null,                           // the Text tool's open editor: { x, y, ta, layout, drag } (document coordinates)
  customFonts: [],                      // fonts loaded from a file with "Font file…"
  keepSize: false,                      // "keep the texture size, do not ask again" was ticked in a bigger-image question (until the app is restarted)
};
let viewer = null;

// ---------------------------------------------------------------- toasts & dialogs
function toast(msg, kind = 'info', ms = 5000) {
  const t = el('div', 'toast ' + kind, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// check: an optional tick box under the text, { label, value }; `value` is updated with what the user left it at
// content: an element for under the text, or a function that gets the finish callback (it ends the dialog with that answer) and returns one; wide: a wider card
// side: the card sits at the left over the panels and nothing is dimmed, so the texture and the 3D view stay visible (a live preview)
function modal({ title, lines = [], input = null, check = null, content = null, wide = false, side = false, buttons }) {
  return new Promise((resolve) => {
    const m = $('#modal'), body = $('#mBody'), btns = $('#mBtns');
    $('#mTitle').textContent = title;
    m.querySelector('.card').classList.toggle('wide', !!wide);
    m.classList.toggle('side', !!side);
    body.textContent = '';
    for (const l of lines) body.append(el('p', '', l));
    if (content) body.append(typeof content === 'function' ? content((v) => done(v)) : content);
    let inp = null, cb = null;
    if (input !== null) {
      inp = el('input');
      inp.type = 'text'; inp.value = input;
      inp.style.cssText = 'width:100%;background:#22262d;border:1px solid #2d323b;border-radius:6px;padding:7px 9px;color:#e6e8ec;user-select:text';
      body.append(inp);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    }
    if (check) {
      const lab = el('label', 'mcheck');
      cb = el('input'); cb.type = 'checkbox'; cb.checked = !!check.value;
      lab.append(cb, document.createTextNode(' ' + check.label));
      body.append(lab);
    }
    const answer = (b) => (b.id === 'cancel' ? null : b.id === 'ok' ? (inp ? inp.value : 'ok') : b.id);
    const primary = buttons.find((b) => b.accent) || buttons[buttons.length - 1];
    const done = (v) => { if (check && cb) check.value = cb.checked; m.hidden = true; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); return; }
      if (e.key !== 'Enter') return;
      const f = document.activeElement;
      if (f && f.tagName === 'BUTTON' && btns.contains(f)) return;            // Enter on a focused button presses that button
      if (f && f.tagName === 'INPUT' && f !== inp && body.contains(f) && f.type !== 'checkbox' && f.type !== 'radio') return;   // Enter in a filter box of the dialog does not answer it
      e.preventDefault(); e.stopPropagation();                                 // otherwise it answers with the main (blue) button
      done(answer(primary));
    };
    btns.textContent = '';
    for (const b of buttons) {
      const bt = el('button', 'btn' + (b.accent ? ' accent' : ''), b.label);
      bt.onclick = () => done(answer(b));
      btns.append(bt);
      if (b === primary && !inp) setTimeout(() => bt.focus(), 0);              // focus moves into the dialog, off the button that opened it
    }
    document.addEventListener('keydown', onKey, true);
    m.hidden = false;
  });
}
const confirmBox = async (title, lines, ok) => (await modal({ title, lines, buttons: [{ id: 'cancel', label: t('Cancel') }, { id: 'ok', label: ok, accent: true }] })) === 'ok';
const askText = (title, value) => modal({ title, input: value, buttons: [{ id: 'cancel', label: t('Cancel') }, { id: 'ok', label: t('OK'), accent: true }] });

const setMsg = (t) => { $('#stMsg').textContent = t || ''; };
const dialogOpen = () => !$('#modal').hidden || !$('#pieceDlg').hidden || !$('#optDlg').hidden;   // shortcuts, paste and drops must not reach the editor behind a dialog

// ---------------------------------------------------------------- pack tree
const collapseKey = (...p) => p.join('|');
function toggleCollapsed(key) {
  if (S.collapsed.has(key)) S.collapsed.delete(key); else S.collapsed.add(key);
  try { localStorage.setItem('cs.collapsed', JSON.stringify([...S.collapsed])); } catch { /* ignore */ }
  renderTree();
}

/** one row of the list: name, texture letters, "+", "×" (opened piece with 2+ textures), "⋯" */
function pieceRow(it) {
  const open = !!(S.sel && S.sel.item === it);
  const row = el('div', 'tree-item' + (open ? ' sel' : ''));
  const nameEl = el('span', 'name', it.ydd ? it.label : t('{label} (no model)', { label: it.label }));
  nameEl.title = t('Click to open this piece. Right-click (or the ⋯ button) for move, add textures and delete.');
  if (it.variants.length) nameEl.onclick = () => selectVariant(it, open ? S.sel.variant : it.variants[0]);
  row.append(nameEl);
  row.oncontextmenu = (e) => { e.preventDefault(); openPieceMenu(it, { x: e.clientX, y: e.clientY }); };

  const chips = el('span', 'chips');
  for (const v of it.variants) {
    const chip = el('span', 'chip', v.letter);
    chip.title = basename(v.ytd) + '\n' + t('Right-click to delete this texture');
    const entry = S.docs.get(v.ytd);
    if (S.sel && S.sel.ytd === v.ytd) chip.classList.add('sel');
    if (entry && entry.doc.dirty) chip.classList.add('dirty');
    chip.onclick = () => selectVariant(it, v);
    chip.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); deleteVariant(it, v); };   // right-click a chip to delete that texture
    chips.append(chip);
  }
  if (it.variants.length) {
    const add = el('span', 'chip add', '+');
    add.title = t('Add a texture: a copy of the current one, or PNG / .ytd files');
    add.onclick = () => plusMenu(it);
    chips.append(add);
  }
  if (open && it.variants.length > 1) {
    const del = el('span', 'chip del', '×');
    del.title = t('Delete texture "{letter}" (goes to the Recycle Bin; later textures move down a letter)', { letter: S.sel.variant.letter });
    del.onclick = () => deleteVariant(it, S.sel.variant);
    chips.append(del);
  }
  const more = el('span', 'chip more', '⋯');
  more.title = t('Move up / down, add textures, delete this piece');
  more.onclick = (e) => { e.stopPropagation(); openPieceMenu(it, more); };
  chips.append(more);
  row.append(chips);
  return row;
}

function renderTree() {
  const root = $('#tree');
  const scroll = root.scrollTop;
  root.textContent = '';
  if (!S.pack) {
    root.append(el('p', 'hint', t('Open or drop a resource folder such as js_gsp. Male and female pieces appear here.')));
    return;
  }
  const q = (S.filter || '').trim().toLowerCase();
  let shown = 0;
  for (const gender of ['male', 'female']) {
    let items = S.pack.items.filter((i) => i.gender === gender);
    if (q) items = items.filter((i) => `${gender} ${i.group} ${i.label} ${i.comp}`.toLowerCase().includes(q));
    if (!items.length) continue;

    const gKey = collapseKey('g', gender), gClosed = !q && S.collapsed.has(gKey);
    const gh = el('div', 'tree-gender ' + gender);
    gh.append(el('span', 'caret', gClosed ? '▸' : '▾'), el('span', 'dot'), el('span', 'gname', genderName(gender)), el('span', 'count', String(items.length)));
    gh.onclick = () => toggleCollapsed(gKey);
    gh.title = gClosed ? t('Show') : t('Hide');
    root.append(gh);
    if (gClosed) continue;

    let group = null, closed = false;
    for (const it of items) {
      if (it.group !== group) {
        group = it.group;
        const key = collapseKey('c', gender, group);
        closed = !q && S.collapsed.has(key);
        const gc = items.filter((i) => i.group === group).length;
        const h = el('div', 'tree-group');
        h.append(el('span', 'caret', closed ? '▸' : '▾'), el('span', 'gtitle', groupText(it)), el('span', 'count', String(gc)));
        h.onclick = () => toggleCollapsed(key);
        root.append(h);
      }
      if (closed) continue;
      root.append(pieceRow(it)); shown += 1;
    }
  }
  if (q && !shown) root.append(el('p', 'hint', t('No piece matches "{filter}".', { filter: S.filter.trim() })));
  root.scrollTop = scroll;
}

// ---------------------------------------------------------------- pieces: add / delete / move / textures / new pack / build
const pad3 = (n) => String(n).padStart(3, '0');
const genderName = (g) => (g === 'male' ? t('Male') : t('Female'));
const pieceName = (it) => `${genderName(it.gender)} ${it.label}`;
const piecesText = (n) => tn(n, '{n} piece', '{n} pieces');
const packTitle = (p) => `${p.name}${p.dlcName ? ' · ' + p.dlcName : ''} · ${piecesText(p.items.length)}`;
/** The pack scan names pieces in English ("Top 000"): they are shown in the language of the editor, the English kept as labelEn. */
function localizePack(pack) {
  for (const it of pack.items) {
    if (it.labelEn === undefined) it.labelEn = it.label;
    it.label = pieceLabel(it);
  }
  return pack;
}
/** A piece name that the main process wrote in English (the .ymt report), as it is shown now. */
const labelOf = (en) => { const f = S.pack && S.pack.items.find((i) => i.labelEn === en); return f ? f.label : en; };
const currentLabel = () => (S.sel ? `${genderName(S.sel.item.gender)} · ${S.sel.item.label} · ${S.sel.variant.letter}` : '');
const sameGroup = (a, b) => a.gender === b.gender && !!a.prop === !!b.prop && a.comp === b.comp;
const relabel = (it, n) => it.label.replace(/\d{3}$/, pad3(n));

function updatePackName() {
  const p = S.pack;
  if (p) $('#packName').textContent = packTitle(p);
}

/** After files were renamed / removed / added on disk: follow open paintings to their new files and rebuild the list. */
async function afterPieceOp({ renames = [], deleted = [], selectId = null, selectLetter = null } = {}) {
  const map = new Map(renames.map((r) => [r.from, r.to]));
  for (const f of deleted) { S.docs.delete(f); S.meshes.delete(f); }
  const docs = new Map();
  for (const [k, e] of S.docs) { const nk = map.get(k) || k; e.ytd = nk; docs.set(nk, e); }
  S.docs = docs;
  const meshes = new Map();
  for (const [k, v] of S.meshes) meshes.set(map.get(k) || k, v);
  S.meshes = meshes;

  const pack = localizePack(await api.scanPack(S.pack.root));
  S.pack = pack;
  for (const [k, e] of [...S.docs]) {                               // point each open painting at the new piece objects
    const it = pack.items.find((i) => i.variants.some((v) => v.ytd === k));
    if (it) { e.item = it; e.variant = it.variants.find((v) => v.ytd === k); } else S.docs.delete(k);
  }
  if (S.sel && !S.docs.has(S.sel.ytd)) S.sel = null;
  updatePackName();
  refreshYmt();
  let pick = (selectId && pack.items.find((i) => i.id === selectId)) || (S.sel && S.sel.item) || null;
  if (!pick || !pick.variants.length) pick = pack.items.find((i) => i.variants.length) || null;     // nothing left to select: take any piece
  for (let i = 0; i < 200 && S.busy; i++) await new Promise((r) => setTimeout(r, 50));              // a piece is still loading: wait for it
  if (pick) {
    const keep = S.sel && S.sel.item === pick ? S.sel.variant : null;
    const v = (selectLetter && pick.variants.find((x) => x.letter === selectLetter)) || keep || pick.variants[0];
    await selectVariant(pick, v);
  } else showEmpty(N_('This pack has no pieces left. Use "Add piece…" in the Pack panel to add .ydd models.'));
}

/** Nothing to edit: hide the canvas and the 3D piece instead of leaving a deleted piece on screen. */
function showEmpty(message) {                       // message: an English text marked with N_(); shown translated (and again when the language changes)
  textEnd(false);
  S.sel = null; S.last = null; S.emptyMsg = message;
  $('#world').style.visibility = 'hidden'; $('#handles').style.visibility = 'hidden';
  viewer.setMesh(null); viewer.refresh();
  $('#current').textContent = ''; $('#stSize').textContent = '–'; $('#vInfo').textContent = ''; $('#btnOptions').hidden = true;
  $('#empty').textContent = t(message); $('#empty').hidden = false;
  if (S.pop) api.viewerSend({ type: 'state', label: '', mesh: null, isProp: false, bone: null, bodyOn: false, hide: [] });
  renderTree();
}

/** The ⋯ menu (or right-click) of any piece in the list - no need to open the piece first. */
let pieceMenuEl = null;
function closePieceMenu() {
  if (!pieceMenuEl) return;
  pieceMenuEl.remove(); pieceMenuEl = null;
  document.removeEventListener('pointerdown', onPieceMenuOutside, true);
  window.removeEventListener('keydown', onPieceMenuKey, true);
  window.removeEventListener('blur', closePieceMenu);
}
function onPieceMenuOutside(e) { if (pieceMenuEl && !pieceMenuEl.contains(e.target)) closePieceMenu(); }
function onPieceMenuKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closePieceMenu(); } }

function openPieceMenu(it, where) {
  closePieceMenu();
  const n = +it.drawable, count = S.pack.items.filter((i) => sameGroup(i, it)).length;
  const menu = el('div', 'piece-menu');
  menu.append(el('div', 'pm-title', pieceName(it)));
  const add = (label, fn, disabled, cls) => {
    const b = el('button', cls || '', label); b.disabled = !!disabled;
    b.onclick = () => { closePieceMenu(); fn(); };
    menu.append(b);
  };
  add('⚙  ' + t('Options… (audio, flags, hair scale …)'), () => openOptions(it), false);
  add('▲  ' + t('Move up (swap with the piece above)'), () => movePieceUi(it, -1), n <= 0);
  add('▼  ' + t('Move down (swap with the piece below)'), () => movePieceUi(it, 1), n >= count - 1);
  add('＋  ' + t('Add textures…'), () => importTexturesUi(it), !it.variants.length);
  add('⧉  ' + t('Copy a texture to other pieces…'), () => copyTextureUi(it), !it.variants.length || S.pack.items.length < 2);
  add('🗑  ' + t('Delete piece…'), () => deletePieceUi(it), false, 'danger');
  document.body.append(menu);
  pieceMenuEl = menu;
  const r = where.getBoundingClientRect ? where.getBoundingClientRect() : null;
  const x = r ? r.right : where.x, y = r ? r.bottom + 4 : where.y;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x - (r ? w : 0), innerWidth - w - 8)) + 'px';
  menu.style.top = Math.max(8, y + h > innerHeight - 8 ? (r ? r.top - h - 4 : y - h) : y) + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', onPieceMenuOutside, true);
    window.addEventListener('keydown', onPieceMenuKey, true);
    window.addEventListener('blur', closePieceMenu);
  }, 0);
}

function warnExtras(files) {
  if (files && files.length) toast(t('These files list pieces by number and were not changed: {files}. Check them if you use heels, hat hair scaling or first-person / alternate variations.', { files: files.join(', ') }), 'warn', 12000);
}

function pieceYmtNote(gender) {
  const g = S.ymt && S.ymt.genders && S.ymt.genders.find((x) => x.gender === gender);
  return g && g.file && !g.error ? t('{file} is updated to match (original kept once as {file}.bak).', { file: g.file }) : t('No usable .ymt was found for this gender, so only the files change.');
}

async function movePieceUi(it, delta) {
  if (S.busy) return;
  const to = +it.drawable + delta;
  const other = S.pack.items.find((i) => sameGroup(i, it) && +i.drawable === to);
  try {
    const res = await api.pieceMove(S.pack.root, it.id, to);
    await afterPieceOp({ renames: res.renames, selectId: `${it.gender}_${it.comp}_${pad3(to)}` });
    const moved = other ? t('{a} is now {b} and {c} is now {a}.', { a: it.label, b: relabel(it, to), c: other.label }) : t('{a} is now {b}.', { a: it.label, b: relabel(it, to) });
    toast(sentences(moved, res.ymt ? t('Files and {ymt} updated.', { ymt: res.ymt }) : t('Files updated.')), 'ok', 6000);
    warnExtras(res.warnings);
  } catch (e) { toast(t('Could not move the piece: {error}', { error: e.message || e }), 'error', 10000); }
}

async function deletePieceUi(it) {
  if (S.busy) return;
  const group = S.pack.items.filter((i) => sameGroup(i, it)).sort((a, b) => +a.drawable - +b.drawable);
  const idx = group.indexOf(it), later = group.slice(idx + 1), n = +it.drawable;
  const dirty = it.variants.some((v) => { const e = S.docs.get(v.ytd); return e && e.doc.dirty; });
  const lines = [
    tn(it.variants.length, '{piece}: its model and {n} texture go to the Recycle Bin (you can restore them from there).', '{piece}: its model and {n} textures go to the Recycle Bin (you can restore them from there).', { piece: pieceName(it) }),
    later.length ? t('The later pieces move down so the numbers stay continuous: {moves}. Their files are renamed and unsaved painting stays with each piece.', { moves: later.map((x) => `${x.label} → ${relabel(x, +x.drawable - 1)}`).join(', ') })
      : t('It is the last piece of its category, so no other piece changes number.'),
  ];
  if (dirty) lines.push(t('You have unsaved painting on it. That painting is lost.'));
  lines.push(pieceYmtNote(it.gender));
  if (!(await confirmBox(t('Delete {piece}?', { piece: it.label }), lines, t('Delete piece')))) return;
  try {
    const res = await api.pieceDelete(S.pack.root, it.id);
    await afterPieceOp({
      renames: res.renames, deleted: res.deleted,
      selectId: later.length ? `${it.gender}_${it.comp}_${pad3(n)}` : (idx > 0 ? `${it.gender}_${it.comp}_${pad3(n - 1)}` : null),
    });
    toast(later.length
      ? t('{piece} moved to the Recycle Bin; {moves}.', { piece: it.label, moves: later.map((x) => t('{a} is now {b}', { a: x.label, b: relabel(x, +x.drawable - 1) })).join(', ') })
      : t('{piece} moved to the Recycle Bin.', { piece: it.label }), 'ok', 7000);
    warnExtras(res.warnings);
  } catch (e) { toast(t('Could not delete the piece: {error}', { error: e.message || e }), 'error', 10000); }
}

/** A picked image file -> pixels at the size of the texture it will become (w x h; `resize` marks a size other than the pack's, which the main process then writes as such). */
async function imageTexture(token, w, h, resize = false) {
  const img = await Paint.loadImage(await api.fileDataUrl(token));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  return { kind: 'png', width: w, height: h, resize, rgba: new Uint8Array(d.buffer, d.byteOffset, d.byteLength) };
}

/**
 * The textures to make from the picked files. Images are scaled to the pack's texture size (tpl), unless `cap` (the longest
 * side the user allowed in askTextureCap, 0 = keep the pack's size) lets a bigger image have a bigger texture; `sizes` is from imageSizes.
 */
async function toTextureSpecs(list, tpl, cap = 0, sizes = new Map()) {
  const out = [];
  for (const t of list) {
    if (t.kind === 'image') {
      const d = sizes.get(t.token);
      const s = d ? textureSizeFor(tpl.width, tpl.height, d.w, d.h, cap) : { w: tpl.width, h: tpl.height, resize: false };
      out.push(await imageTexture(t.token, s.w, s.h, s.resize));
    } else if (t.kind === 'ytd') out.push({ kind: 'ytd', token: t.token });
    else out.push({ kind: 'blank' });
  }
  return out;
}

/** How big (w x h) each picked image is, by token. The decoded pictures are not kept: a 4096 x 4096 image is 64 MB. */
async function imageSizes(tokens) {
  const out = new Map();
  for (const token of tokens) {
    if (out.has(token)) continue;
    try { const img = await Paint.loadImage(await api.fileDataUrl(token)); out.set(token, { w: img.naturalWidth, h: img.naturalHeight }); } catch { /* the problem shows when that texture is made */ }
  }
  return out;
}

/** "In game a 1024×1024 DXT1 texture takes about 0.7 MB; 2048×2048 about 2.7 MB": what the bigger sizes cost (sizes: [{ w, h }]). */
const memoryLine = (w, h, fmt, sizes) => t('In game a {size} {fmt} texture takes about {mem}; {others}.', {
  size: `${w}×${h}`, fmt, mem: mbText(memoryMB(w, h, fmt)),
  others: sizes.map((s) => t('{size} about {mem}', { size: `${s.w}×${s.h}`, mem: mbText(memoryMB(s.w, s.h, fmt)) })).join(', '),
});

/**
 * The question of the Add flows. Some picked images are bigger than the pack's textures (1024×1024 for a new pack), and a
 * texture's size is stored in its own .ytd, so each can have its own: keep the pack's size (the image is scaled down), or
 * make the texture bigger. batches: [{ tpl, textures }], sizes: from imageSizes. Answers the longest side the new
 * textures may get (0 = keep the pack's size), or null for Cancel.
 */
async function askTextureCap(batches, sizes) {
  if (S.keepSize) return 0;
  const items = [];
  for (const b of batches) for (const t of b.textures) {
    const d = t.kind === 'image' && sizes.get(t.token);
    if (d) items.push({ name: t.name, w: d.w, h: d.h, tplW: b.tpl.width, tplH: b.tpl.height });
  }
  const q = addChoices(items);
  if (!q) return 0;
  const n = q.bigger.length, one = n === 1, first = q.bigger[0], fmt = batches[0].tpl.format || 'DXT1';
  const keepText = [...new Set(q.bigger.map((i) => `${i.tplW}×${i.tplH}`))].join(' / ');
  const someNames = q.bigger.slice(0, 4).map((i) => `${i.name} (${i.w}×${i.h})`).join(', ');
  const names = n > 4 ? t('{names} and {n} more', { names: someNames, n: n - 4 }) : someNames;
  const sizeAt = (cap) => textureSizeFor(first.tplW, first.tplH, one ? first.w : 99999, one ? first.h : 99999, cap);
  const check = { label: t('Always keep the pack size, do not ask again (until the app is restarted)'), value: false };
  const r = await modal({
    title: one ? t('This image is bigger than the texture') : t('Some images are bigger than the textures'),
    lines: [
      tn(n, 'This image is bigger than the {size} texture of this pack: {names}.', '{n} of these images are bigger than the {size} textures of this pack: {names}.', { size: keepText, names }),
      tn(n, 'Keep {size} and it is scaled down. Or give the new texture the size of the image so the detail is kept. A texture\'s size is stored in its own .ytd, so it may differ from the rest of the pack.', 'Keep {size} and they are scaled down. Or give the new textures the size they need so the detail is kept. A texture\'s size is stored in its own .ytd, so it may differ from the rest of the pack.', { size: keepText }),
      memoryLine(first.tplW, first.tplH, fmt, q.caps.map(sizeAt)),
    ],
    check,
    buttons: [{ id: 'cancel', label: t('Cancel') }, { id: 'keep', label: t('Keep {size}', { size: keepText }), accent: true },
      ...q.caps.map((c) => { const s = sizeAt(c); return { id: 'cap' + c, label: one ? t('Make it {size}', { size: `${s.w}×${s.h}` }) : t('Up to {size}', { size: `${s.w}×${s.h}` }) }; })],
  });
  if (!r) return null;
  if (r === 'keep') { if (check.value) S.keepSize = true; return 0; }
  return parseInt(r.slice(3), 10);
}

async function importTexturesUi(it) {
  if (S.busy) return;
  try {
    const picks = await api.pickTextures();
    if (!picks.length) return;
    const tpl = await api.pieceTemplate(S.pack.root, it.gender, !!it.prop, it.comp, it.id);
    const sizes = await imageSizes(picks.filter((p) => p.kind === 'image').map((p) => p.token));
    const cap = await askTextureCap([{ tpl, textures: picks }], sizes);
    if (cap === null) return;                                       // Cancel: nothing is added
    setMsg(t('Adding textures…'));
    const specs = await toTextureSpecs(picks, tpl, cap, sizes);
    const res = await api.pieceAddTextures(S.pack.root, it.id, specs);
    const last = res.files[res.files.length - 1];
    const letter = (/_([a-z])(?:_[a-z]{3})?\.ytd$/i.exec(basename(last)) || [])[1] || null;
    await afterPieceOp({ selectId: it.id, selectLetter: letter });
    const grown = [...new Set(specs.filter((s) => s.resize).map((s) => `${s.width}×${s.height}`))];
    const made = res.files.length, here = { piece: it.label };
    toast(grown.length ? tn(made, 'Added {n} texture to {piece} (bigger than its other textures: {sizes}).', 'Added {n} textures to {piece} (bigger than its other textures: {sizes}).', { ...here, sizes: grown.join(', ') })
      : tpl.width ? tn(made, 'Added {n} texture to {piece} (images are scaled to {size} like its other textures).', 'Added {n} textures to {piece} (images are scaled to {size} like its other textures).', { ...here, size: `${tpl.width}×${tpl.height}` })
        : tn(made, 'Added {n} texture to {piece}.', 'Added {n} textures to {piece}.', here), 'ok', 7000);
  } catch (e) { toast(t('Could not add the textures: {error}', { error: e.message || e }), 'error', 10000); } finally { setMsg(''); }
}

/** The Options dialog of a piece: audio, flags, render flag, hair scale (hats), high heels (shoes), shows skin. */
async function openOptions(it) {
  if (S.busy) return;
  const root = S.pack.root;
  try {
    const data = await api.pieceOptions(root, it.id);
    data.label = it.label;                                         // the name in the language of the editor (the main process writes it in English)
    const changes = await optionsDialog({ data });
    if (!changes) return;
    if (!Object.keys(changes).length) { toast(t('Nothing was changed.'), 'info', 2500); return; }
    setMsg(t('Saving options…'));
    const res = await api.pieceSetOptions(root, it.id, changes);
    await afterPieceOp({ renames: res.renames, selectId: it.id });
    toast(changes.hasSkin !== undefined ? t('Saved the options of {piece} in {file} (the files were renamed).', { piece: it.label, file: res.ymt }) : t('Saved the options of {piece} in {file}.', { piece: it.label, file: res.ymt }), 'ok', 5000);
    if (res.warnings && res.warnings.length) toast(res.warnings.join(' | '), 'warn', 9000);
  } catch (e) { toast(t('Could not use the options: {error}', { error: e.message || e }), 'error', 9000); } finally { setMsg(''); }
}

/** "+" next to the texture chips: a copy of the current texture, or new ones from PNG / JPG / .ytd files. */
async function plusMenu(it) {
  const src = S.sel && S.sel.item === it ? S.sel.variant : it.variants[it.variants.length - 1];
  const next = String.fromCharCode(Math.max(...it.variants.map((v) => v.letter.charCodeAt(0))) + 1);
  const choice = await modal({
    title: t('Add texture {letter} to {piece}', { letter: next, piece: it.label }),
    lines: [t('Copy "{letter}" to start from it, or bring in your own image or .ytd files.', { letter: src.letter })],
    buttons: [{ id: 'cancel', label: t('Cancel') }, { id: 'copy', label: t('Copy of "{letter}"', { letter: src.letter }) }, { id: 'ok', label: t('Import PNG / YTD…'), accent: true }],
  });
  if (choice === 'copy') addVariant(it, { skipConfirm: true });
  else if (choice === 'ok') importTexturesUi(it);
}

/** Add .ydd models: pick them (or drop them), say what each is, give each its textures. */
async function addPiecesFlow(infos) {
  if (S.busy) return;
  if (!S.pack) { toast(t('Open or create a pack first.'), 'warn'); return; }
  try {
    if (!infos) infos = await api.pickYdd();
    if (!infos || !infos.length) return;
    const rows = await addPieceDialog({ api, infos, defaultGender: S.sel ? S.sel.item.gender : 'male', toast });
    if (!rows || !rows.length) return;
    const problems = [];
    const plans = [];                                                // each model, with the texture size its slot of the pack uses
    for (const r of rows) {
      try { plans.push({ r, tpl: await api.pieceTemplate(S.pack.root, r.gender, r.prop, r.comp, null) }); }
      catch (e) { problems.push(`${r.info.name}: ${e.message || e}`); }
    }
    const sizes = await imageSizes(plans.flatMap((p) => p.r.textures.filter((x) => x.kind === 'image').map((x) => x.token)));
    const cap = await askTextureCap(plans.map((p) => ({ tpl: p.tpl, textures: p.r.textures })), sizes);     // one question for all images
    if (cap === null) return;                                        // Cancel: nothing is added
    setMsg(t('Adding pieces…'));
    let last = null, added = 0;
    for (const { r, tpl } of plans) {
      try {
        const textures = await toTextureSpecs(r.textures, tpl, cap, sizes);
        if (!textures.length) textures.push({ kind: 'blank' });
        const res = await api.pieceAdd(S.pack.root, { gender: r.gender, prop: r.prop, comp: r.comp, hasSkin: r.hasSkin, yddToken: r.info.token, textures });
        last = res.id; added += 1;
      } catch (e) { problems.push(`${r.info.name}: ${e.message || e}`); }
    }
    if (added) await afterPieceOp({ selectId: last });
    if (added) toast(tn(added, 'Added {n} piece. Paint on its textures, then Save to YTD.', 'Added {n} pieces. Paint on their textures, then Save to YTD.'), 'ok', 7000);
    if (problems.length) toast(t('Could not add: {error}', { error: problems.join(' | ') }), 'error', 14000);
  } catch (e) { toast(t('Could not add pieces: {error}', { error: e.message || e }), 'error', 10000); } finally { setMsg(''); }
}

async function newPackUi() {
  const name = await askText(t('New pack - resource name (letters, digits, underscore)'), 'my_clothes');
  if (!name || !name.trim()) return;
  try {
    const pack = await api.packNew(name.trim());
    if (!pack) return;
    await loadPack(pack);
    toast(t('Created {name}. Now choose the .ydd models to put in it.', { name: pack.name }), 'ok', 6000);
    await addPiecesFlow();
  } catch (e) { toast(String(e.message || e), 'error', 9000); }
}

/** "Build": a FiveM resource folder for a server, or a single-player DLC pack (dlc.rpf) for story mode. */
async function buildPackUi() {
  if (!S.pack) { toast(t('Open a pack first.'), 'warn'); return; }
  let last = 'fivem';
  try { last = localStorage.getItem('cs.buildTarget') === 'sp' ? 'sp' : 'fivem'; } catch { /* ignore */ }
  const choice = await modal({
    title: t('Build the pack for…'),
    lines: [
      t('FiveM resource: a clean resource folder for your server (stream files, .meta files, .ymt, fxmanifest.lua).'),
      t('Single player: a dlc.rpf DLC pack for story mode, installed with OpenIV. It follows the layout of the game\'s own clothing DLCs but has not been tried in game yet.'),
    ],
    buttons: [{ id: 'cancel', label: t('Cancel') }, { id: 'sp', label: t('Single player (dlc.rpf)'), accent: last === 'sp' }, { id: 'fivem', label: t('FiveM resource'), accent: last !== 'sp' }],
  });
  if (!choice) return;
  try { localStorage.setItem('cs.buildTarget', choice); } catch { /* ignore */ }
  const sp = choice === 'sp';
  const name = await askText(sp ? t('Build single-player pack - name') : t('Build FiveM resource - name'), S.pack.dlcName || S.pack.name);
  if (!name || !name.trim()) return;
  try {
    setMsg(t('Building…'));
    const rep = await api.packBuild(S.pack.root, name.trim(), sp ? 'sp' : 'fivem');
    if (!rep) return;
    await modal(sp ? {
      title: t('Single-player pack built'),
      lines: [
        rep.root,
        tn(rep.files, '{n} stream file is packed into dlc.rpf ({size}).', '{n} stream files are packed into dlc.rpf ({size}).', { size: mbText(rep.bytes / 1048576) }),
        ...(rep.notes || []),
        t('Copy the folder into <your GTA V folder>\\mods\\update\\x64\\dlcpacks\\ (OpenIV\'s mods folder) and add this line to dlclist.xml:'),
        rep.dlclist,
        t('INSTALL.txt in the folder explains each step. Keep a backup of your game files: this was not tried in game yet.'),
      ],
      buttons: [{ id: 'ok', label: t('OK'), accent: true }],
    } : {
      title: t('FiveM resource built'),
      lines: [
        rep.root,
        tn(rep.files, '{n} stream file copied, plus {ymt}, the .meta files and fxmanifest.lua.', '{n} stream files copied, plus {ymt}, the .meta files and fxmanifest.lua.', { ymt: list(rep.ymt) }),
        ...(rep.notes || []),
        t('Copy the folder into your server\'s resources and add "ensure {name}" to server.cfg.', { name: rep.name }),
      ],
      buttons: [{ id: 'ok', label: t('OK'), accent: true }],
    });
  } catch (e) { toast(t('Build failed: {error}', { error: e.message || e }), 'error', 12000); } finally { setMsg(''); }
}

/** One sentence for the add / delete dialogs about what happens to the pack's .ymt. */
function ymtNote(gender) {
  const g = S.ymt && S.ymt.genders && S.ymt.genders.find((x) => x.gender === gender);
  if (g && g.file && !g.error) return t('{file} (the file that tells the game how many textures each piece has) is updated to match. Its original is kept once as {file}.bak.', { file: g.file });
  if (g && g.error) return t('{file} could not be read, so it will not be updated and the game will not know about this change until it is rebuilt.', { file: g.file });
  return t('No .ymt was found in this pack, so the game will not know about this change until one exists.');
}

/** "+" next to the a / b chips: make the next texture variant (c after b ...) as a new .ytd beside the others. */
async function addVariant(it, opts = {}) {
  if (S.busy || !it.variants.length) return;
  const cur = S.sel && S.sel.item === it ? S.sel.variant : null;
  const src = cur || it.variants[it.variants.length - 1];
  const used = it.variants.map((v) => v.letter);
  const next = String.fromCharCode(Math.max(...used.map((l) => l.charCodeAt(0))) + 1);
  const entry = S.docs.get(src.ytd);
  const painted = !!(cur && entry && entry.doc.dirty);        // you have unsaved paint on the one you copy from
  const name = basename(src.ytd).replace(new RegExp(`_${src.letter}(?=(_[a-z]{3})?\\.ytd$)`, 'i'), `_${next}`);
  const lines = [
    t('{piece} gets a new texture "{letter}":', { piece: pieceName(it), letter: next }),
    name,
    t('It starts as a copy of "{letter}". Nothing existing is changed or overwritten.', { letter: src.letter }),
    ymtNote(it.gender),
  ];
  let how = 'disk';
  if (painted) {
    how = await modal({
      title: t('Add texture {letter}', { letter: next }),
      lines: [...lines.slice(0, 2), t('You have unsaved painting on "{letter}". What should "{next}" start as?', { letter: src.letter, next }), lines[3]],
      buttons: [{ id: 'cancel', label: t('Cancel') }, { id: 'disk', label: t('Copy saved "{letter}"', { letter: src.letter }) }, { id: 'ok', label: t('Copy my painting'), accent: true }],
    });
    if (!how) return;
    if (how === 'ok') how = 'paint';
  } else if (!opts.skipConfirm && !(await confirmBox(t('Add texture {letter}', { letter: next }), lines, t('Create {letter}', { letter: next })))) return;

  try {
    setMsg(t('Creating the new texture…'));
    const res = await api.addVariant(src.ytd, used);
    if (how === 'paint') {
      const rgba = Paint.flatRGBA(entry.doc);
      await api.saveTexture(res.file, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), { backup: false, width: entry.doc.w, height: entry.doc.h });   // the painting may have a new size (the copy then gets it)
    }
    const v = { letter: res.letter, race: res.race || null, ytd: res.file };
    it.variants.push(v);
    it.variants.sort((a, b) => a.letter.localeCompare(b.letter));
    await selectVariant(it, v);
    toast(how === 'paint' ? t('Created {file} from your painting. Paint on it, then Save to YTD.', { file: basename(res.file) }) : t('Created {file}. Paint on it, then Save to YTD.', { file: basename(res.file) }), 'ok', 7000);
    await syncYmt({ gender: it.gender, only: it.id });
  } catch (e) {
    toast(t('Could not add the texture: {error}', { error: e.message || e }), 'error', 9000);
    try { await afterPieceOp(); } catch { /* the list is refreshed from disk so it shows what really exists */ }
  } finally { setMsg(''); }
}

/**
 * "×" (or right-click a chip): delete a texture you do not want. It goes to the Recycle Bin and the textures after it
 * move down a letter (delete c from a,b,c,d and d becomes the new c), so you never have to re-export anything.
 */
async function deleteVariant(it, v) {
  if (S.busy) return;
  if (it.variants.length < 2) { toast(t('A piece needs at least one texture, so its only texture cannot be deleted.'), 'warn', 7000); return; }
  const order = it.variants, idx = order.indexOf(v);
  if (idx < 0) return;
  const moves = order.slice(idx + 1).map((x, i) => ({ v: x, from: x.letter, to: order[idx + i].letter }));
  const entry = S.docs.get(v.ytd);
  const lines = [
    t('{piece}, texture "{letter}":', { piece: pieceName(it), letter: v.letter }),
    basename(v.ytd),
    t('The file is moved to the Recycle Bin, so you can still restore it from there.'),
  ];
  if (moves.length) lines.push(t('The later textures then move down so the letters stay in order: {moves}. Their files are renamed and any unsaved painting stays with its texture.', { moves: moves.map((m) => `${m.from} → ${m.to}`).join(', ') }));
  if (entry && entry.doc.dirty) lines.push(t('You have unsaved painting on "{letter}". That painting is lost.', { letter: v.letter }));
  lines.push(ymtNote(it.gender));
  if (!(await confirmBox(t('Delete texture {letter}?', { letter: v.letter }), lines, t('Delete {letter}', { letter: v.letter })))) return;

  try {
    const res = await api.deleteVariant(v.ytd);
    const wasSelected = !!(S.sel && S.sel.ytd === v.ytd);
    S.docs.delete(v.ytd);
    it.variants = order.filter((x) => x !== v);
    for (const r of res.renames || []) {             // follow each moved file: path + letter, and its open painting
      const x = it.variants.find((q) => q.ytd === r.from);
      if (!x) continue;
      x.ytd = r.to; x.letter = r.letter;
      const e = S.docs.get(r.from);
      if (e) { S.docs.delete(r.from); S.docs.set(r.to, e); e.ytd = r.to; }
    }
    toast(moves.length
      ? t('Texture "{letter}" moved to the Recycle Bin; {moves}.', { letter: v.letter, moves: moves.map((m) => t('{a} is now {b}', { a: m.from, b: m.to })).join(', ') })
      : t('Texture "{letter}" moved to the Recycle Bin.', { letter: v.letter }), 'ok', 6000);
    if (wasSelected) await selectVariant(it, it.variants[Math.min(idx, it.variants.length - 1)]);
    else {
      if (S.sel && S.sel.item === it) {              // the piece you are editing may have been renamed under you
        $('#current').textContent = currentLabel();
        setMsg(t('Editing {file}', { file: basename(S.sel.ytd) }));
        if (S.pop) api.viewerSend({ type: 'label', label: $('#current').textContent });
      }
      renderTree();
    }
    await syncYmt({ gender: it.gender, only: it.id });
  } catch (e) {
    toast(t('Could not delete the texture: {error}', { error: e.message || e }), 'error', 9000);
    try { await afterPieceOp(); } catch { /* the list is refreshed from disk so it shows what really exists */ }
  }
}

// ---------------------------------------------------------------- copy a texture to other pieces
/**
 * A list of pieces with a tick box each, grouped like the Pack list, with a filter box and two quick buttons. `picked` (a Set) holds
 * the ticked pieces; "Tick the same kind" ticks the shown pieces of the same gender and category as `same`.
 */
function pieceChecklist(items, same, picked) {
  const box = el('div', 'copybox');
  const bar = el('div', 'copybar');
  const filter = el('input'); filter.type = 'search'; filter.placeholder = t('Filter pieces…'); filter.spellcheck = false; filter.autocomplete = 'off';
  const sameBtn = el('button', 'btn small', t('Tick the same kind'));
  const noneBtn = el('button', 'btn small', t('Untick all'));
  const count = el('span', 'muted copycount');
  bar.append(filter, sameBtn, noneBtn, count);
  const list = el('div', 'copylist');
  const rows = [];
  let group = null, head = null;
  for (const gender of ['male', 'female']) {
    for (const it of items.filter((i) => i.gender === gender)) {
      if (`${gender}|${it.group}` !== group) {
        group = `${gender}|${it.group}`;
        head = el('div', 'copyhead', `${genderName(gender)} · ${groupText(it)}`);
        list.append(head);
      }
      const row = el('label', 'copyrow');
      const cb = el('input'); cb.type = 'checkbox';
      row.append(cb, el('span', 'copyname', it.label), el('span', 'muted', it.variants.map((v) => v.letter).join(' ')));
      list.append(row);
      const r = { it, row, cb, head };
      cb.onchange = () => { if (cb.checked) picked.add(it); else picked.delete(it); update(); };
      rows.push(r);
    }
  }
  const update = () => { count.textContent = tn(picked.size, '{n} piece ticked', '{n} pieces ticked'); };
  filter.oninput = () => {
    const q = filter.value.trim().toLowerCase(), heads = new Set();
    for (const r of rows) {
      const show = !q || `${r.it.gender} ${genderName(r.it.gender)} ${r.it.group} ${groupText(r.it)} ${r.it.label} ${r.it.comp}`.toLowerCase().includes(q);
      r.row.hidden = !show;
      if (show) heads.add(r.head);
    }
    for (const r of rows) r.head.hidden = !heads.has(r.head);
  };
  sameBtn.onclick = () => {
    for (const r of rows) if (!r.row.hidden && r.it.gender === same.gender && r.it.comp === same.comp && !!r.it.prop === !!same.prop) { r.cb.checked = true; picked.add(r.it); }
    update();
  };
  noneBtn.onclick = () => { for (const r of rows) r.cb.checked = false; picked.clear(); update(); };
  box.append(bar, list);
  update();
  setTimeout(() => filter.focus(), 30);                             // after the dialog has focused its main button: typing filters at once
  return box;
}

/**
 * Copy a texture of a piece onto other pieces (other models): every ticked piece gets the copy as its next texture letter. The copy is
 * the .ytd as it is saved (same size and format), or, when you choose it, your unsaved painting on it. The .ymt follows.
 */
async function copyTextureUi(it, v) {
  if (S.busy || !S.pack || !it || !it.variants.length) return;
  if (!textSettle()) return;                                       // text you are still typing is part of the painting
  const others = S.pack.items.filter((i) => i !== it && i.variants.length && i.variants.length < 26);   // a - z: a full piece cannot take one more
  if (!others.length) { toast(t('There is no other piece to copy the texture to.'), 'warn'); return; }
  let src = (v && it.variants.includes(v) && v) || (S.sel && S.sel.item === it ? S.sel.variant : it.variants[0]);
  const picked = new Set();
  const choice = await modal({
    title: t('Copy a texture to other pieces'),
    wide: true,
    lines: [t('Tick the pieces that get a copy of this texture as their next texture. A model with a different UV layout shows it differently, so pieces of the same kind work best.')],
    content: () => {
      const wrap = el('div');
      const row = el('div', 'copysrc');
      row.append(el('span', '', t('Texture of {piece}:', { piece: pieceName(it) })));
      for (const x of it.variants) {
        const lab = el('label', 'copyletter');
        const rb = el('input'); rb.type = 'radio'; rb.name = 'copysrc'; rb.checked = x === src;
        rb.onchange = () => { if (rb.checked) src = x; };
        lab.append(rb, document.createTextNode(' ' + x.letter));
        row.append(lab);
      }
      wrap.append(row, pieceChecklist(others, it, picked));
      return wrap;
    },
    buttons: [{ id: 'cancel', label: t('Cancel') }, { id: 'ok', label: t('Copy'), accent: true }],
  });
  if (choice !== 'ok') return;
  const targets = others.filter((i) => picked.has(i));
  if (!targets.length) { toast(t('Tick at least one piece to copy the texture to.'), 'warn', 5000); return; }
  const entry = S.docs.get(src.ytd);
  let how = 'disk';
  if (entry && entry.doc.dirty) {
    how = await modal({
      title: t('Copy a texture to other pieces'),
      lines: [t('You have unsaved painting on "{letter}". Should the copies have your painting, or the texture as it is saved?', { letter: src.letter })],
      buttons: [{ id: 'cancel', label: t('Cancel') }, { id: 'disk', label: t('Copy saved "{letter}"', { letter: src.letter }) }, { id: 'ok', label: t('Copy my painting'), accent: true }],
    });
    if (!how) return;
    if (how === 'ok') how = 'paint';
  }
  let spec;
  if (how === 'paint') {
    const rgba = Paint.flatRGBA(entry.doc);                         // at the painting's own size (it may have been made bigger)
    spec = { kind: 'png', width: entry.doc.w, height: entry.doc.h, resize: true, rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) };
  } else spec = { kind: 'copy', ytd: src.ytd };
  const done = [], failed = [];
  try {
    setMsg(t('Copying the texture…'));
    for (const target of targets) {
      try {
        const res = await api.pieceAddTextures(S.pack.root, target.id, [spec]);
        const letter = (/_([a-z])(?:_[a-z]{3})?\.ytd$/i.exec(basename(res.files[0])) || [])[1] || '?';
        done.push(`${target.label} ${letter}`);
      } catch (e) { failed.push(`${target.label}: ${e.message || e}`); }
    }
    if (done.length) await afterPieceOp({ selectId: it.id, selectLetter: src.letter });
  } finally { setMsg(''); }
  if (done.length) toast(tn(done.length, 'Copied texture "{letter}" to {n} piece: {pieces}.', 'Copied texture "{letter}" to {n} pieces: {pieces}.', { letter: src.letter, pieces: done.join(', ') }), 'ok', 9000);
  if (failed.length) toast(t('Could not copy to: {error}', { error: failed.join(' | ') }), 'error', 14000);
}

// ---------------------------------------------------------------- the pack's .ymt (texture counts the game reads)

/** Ask the main process how the .ymt files compare with the textures on disk and show it in the top bar. */
async function refreshYmt() {
  const chip = $('#ymtChip');
  if (!S.pack || !api.ymtStatus) { chip.hidden = true; return; }
  let st = null;
  try { st = await api.ymtStatus(S.pack.root); } catch (e) { st = { error: String(e.message || e) }; }
  S.ymt = st;
  if (!st) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.className = 'ymt';
  const gs = st.genders || [];
  const found = gs.filter((g) => g.file);
  const bad = found.reduce((n, g) => n + g.diffs.length + g.missing.length, 0);
  if (st.error || found.some((g) => g.error)) { chip.textContent = '.ymt ?'; chip.classList.add('err'); chip.title = t('Could not read the .ymt - click for details'); }
  else if (!found.length) { chip.textContent = t('no .ymt'); chip.title = t('No ped .ymt was found in this pack\'s stream folder'); }
  else if (bad) { chip.textContent = t('.ymt ≠ files ({n})', { n: bad }); chip.classList.add('warn'); chip.title = t('The .ymt does not match the pieces / textures on disk - click to see and fix'); }
  else { chip.textContent = '.ymt ✓'; chip.classList.add('ok'); chip.title = t('The .ymt matches the texture files'); }
}

async function showYmt() {
  await refreshYmt();
  const st = S.ymt;
  if (!st) return;
  const lines = [];
  if (st.error) lines.push(st.error);
  for (const g of st.genders || []) {
    if (!g.file) { lines.push(t('{gender}: no .ymt file found.', { gender: genderName(g.gender) })); continue; }
    if (g.error) { lines.push(t('{file}: could not be read ({error}). Nothing is changed.', { file: g.file, error: g.error })); continue; }
    if (!g.diffs.length && !g.missing.length) { lines.push(t('{file}: matches the files.', { file: g.file })); continue; }
    for (const d of g.diffs) lines.push(t('{file}: {piece} has {listed} listed but {files}.', { file: g.file, piece: labelOf(d.label), listed: tn(d.have, '{n} texture', '{n} textures'), files: tn(d.want, '{n} file', '{n} files') }));
    for (const m of g.missing) lines.push(t('{file}: {piece} has files but is not listed in the .ymt.', { file: g.file, piece: labelOf(m.label) }));
  }
  const fixable = (st.genders || []).some((g) => (g.diffs && g.diffs.length) || (g.missing && g.missing.length));
  if (fixable) lines.push(t('Update fixes the texture counts and lists missing pieces, keeps everything else in the .ymt as it is, and saves the original once as .ymt.bak. (A piece can only be listed when its number follows on from the others.)'));
  const r = await modal({
    title: t('Pack .ymt'), lines,
    buttons: fixable ? [{ id: 'cancel', label: t('Close') }, { id: 'ok', label: t('Update .ymt'), accent: true }] : [{ id: 'cancel', label: t('Close') }],
  });
  if (r === 'ok') await syncYmt({}, true);
}

/** Make the .ymt match the files (opts.only restricts it to one piece). Returns a short text for a toast, or null. */
async function syncYmt(opts, loud) {
  if (!S.pack || !api.ymtSync) return null;
  try {
    const res = await api.ymtSync(S.pack.root, opts);
    if (!res) return null;
    const bits = [];
    for (const r of res.results) {
      if (r.error) toast(t('Could not update {file}: {error}. The .ymt was not changed.', { file: r.file, error: r.error }), 'warn', 10000);
      else if (!r.file) bits.push(r.gender === 'male' ? t('no male .ymt found') : t('no female .ymt found'));
      else if (r.changes && r.changes.length) {
        const what = r.changes.map((c) => `${labelOf(c.label)} ${c.from} → ${c.to}`).join(', ');
        bits.push(r.backup ? t('{file}: {changes} (original kept as {backup})', { file: r.file, changes: what, backup: r.backup }) : `${r.file}: ${what}`);
      }
    }
    await refreshYmt();
    if (bits.length) toast(t('Updated the .ymt - {changes}', { changes: bits.join('; ') }), 'ok', 9000);
    else if (loud) toast(t('The .ymt already matches the files.'), 'ok', 4000);
    return bits.join('; ');
  } catch (e) {
    toast(t('Could not update the .ymt: {error}', { error: e.message || e }), 'warn', 9000);
    return null;
  }
}

async function loadPack(pack) {
  if (S.opBusy) { toast(t('Wait for the current operation to finish first.'), 'warn', 3000); return; }
  if (!textSettle()) return;
  if (window.csDirty && window.csDirty() &&
      !(await confirmBox(t('Unsaved painting'), [t('You have painting that is not saved to a .ytd or a layers file. Opening a pack throws it away.')], t('Discard and open')))) return;
  S.docs.clear(); S.meshes.clear(); S.sel = null; S.last = null;       // nothing from the previous pack may leak into this one
  S.pack = localizePack(pack);
  refreshYmt();
  if (pack.recovered) {
    const rc = pack.recovered;
    if (rc.rolledBack) toast(tn(rc.rolledBack, 'An earlier operation was interrupted. {n} file change was undone, so the pack is back as it was before it.', 'An earlier operation was interrupted. {n} file changes were undone, so the pack is back as it was before it.'), 'warn', 12000);
    if (rc.restored.length) {
      const some = rc.restored.slice(0, 4).join(', ') + (rc.restored.length > 4 ? ' …' : '');
      toast(tn(rc.restored.length, '{n} file was put back under its original name: {files}.', '{n} files were put back under their original names: {files}.', { files: some }), 'warn', 12000);
    }
    if (rc.stuck.length) toast(tn(rc.stuck.length, '{files} could not be put back (the original name is taken). Rename it by hand by removing ".cs_mv".', '{files} could not be put back (the original names are taken). Rename them by hand by removing ".cs_mv".', { files: rc.stuck.join(', ') }), 'error', 15000);
  }
  updatePackName();
  renderTree();
  toast(tn(pack.items.length, 'Opened {name}: {n} piece found.', 'Opened {name}: {n} pieces found.', { name: pack.name }), 'ok', 3000);
  const usable = pack.items.filter((i) => i.ydd && i.variants.length);
  const first = usable.find((i) => i.gender === 'male' && i.comp === 'p_head') || usable.find((i) => i.gender === 'male')
    || usable[0] || pack.items.find((i) => i.variants.length);
  if (first) await selectVariant(first, first.variants[0]);
  else showEmpty(N_('This pack has no pieces yet. Use "Add piece…" in the Pack panel to add .ydd models.'));
}

async function openPackDialog() {
  try {
    const pack = await api.openPack();
    if (pack) await loadPack(pack);
  } catch (e) { toast(String(e.message || e), 'error', 8000); }
}

// ---------------------------------------------------------------- UV guide + preview texture
function uvGuideCanvas(drawable, w, h) {
  if (!drawable || !drawable.models.length) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.lineWidth = Math.max(1, Math.round(Math.max(w, h) / 1024));
  g.lineJoin = 'round';
  drawable.models[0].geometries.forEach((geo, gi) => {
    if (!geo.uvs) return;
    const hue = (gi * 67 + 190) % 360;
    g.strokeStyle = `hsla(${hue},95%,68%,0.9)`;
    g.fillStyle = `hsla(${hue},95%,60%,0.12)`;
    g.beginPath();
    const ix = geo.indices, uv = geo.uvs;
    for (let i = 0; i + 2 < ix.length; i += 3) {
      const a = ix[i], b = ix[i + 1], d = ix[i + 2];
      const u = [uv[a * 2], uv[b * 2], uv[d * 2]], v = [uv[a * 2 + 1], uv[b * 2 + 1], uv[d * 2 + 1]];
      const su = -Math.floor((u[0] + u[1] + u[2]) / 3), sv = -Math.floor((v[0] + v[1] + v[2]) / 3); // tiled UVs wrap back into 0..1
      g.moveTo((u[0] + su) * w, (v[0] + sv) * h);
      g.lineTo((u[1] + su) * w, (v[1] + sv) * h);
      g.lineTo((u[2] + su) * w, (v[2] + sv) * h);
      g.closePath();
    }
    g.fill(); g.stroke();
  });
  return c;
}

function makePreviewCanvas(w, h) {
  const k = Math.min(1, 1024 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  return c;
}

/** The status bar's texture size: what the open painting is now, and (until Save to YTD) what the .ytd still has. */
function showTexSize(e) {
  const d = e.doc, tx = e.tex;
  $('#stSize').textContent = d.w === tx.width && d.h === tx.height
    ? (tx.mips > 1 ? t('{size} {fmt} · {mips} mips', { size: `${tx.width}×${tx.height}`, fmt: tx.format, mips: tx.mips }) : `${tx.width}×${tx.height} ${tx.format}`)
    : t('{size} {fmt} · resized from {from}, not saved yet', { size: `${d.w}×${d.h}`, fmt: tx.format, from: `${tx.width}×${tx.height}` });
}

/** Give the open texture another resolution (the .ytd itself changes when you press Save to YTD). False if that was not possible. */
function resizeTextureTo(w, h) {
  if (!S.sel || !Paint.doc || !textSettle()) return false;
  Paint.resizeDoc(w, h);
  return true;
}

/** The painting's resolution changed - a resize, or Undo / Redo of one: what was made for the old size follows. */
function onDocResized() {
  const e = S.sel, d = Paint.doc;
  if (!e || !d || e.doc !== d) return;
  const g = d.guide;
  if (g && g.uv) {                                                 // the model's UV lines, drawn again for the new size so they stay crisp
    const mesh = e.item.ydd && S.meshes.get(e.item.ydd), drawable = mesh && mesh.drawables[0];
    const uv = drawable && uvGuideCanvas(drawable, d.w, d.h);
    if (uv) { e.uv = uv; Paint.setGuide(uv); d.guide.opacity = g.opacity; d.guide.visible = g.visible; d.guide.uv = true; }
  }
  const pv = makePreviewCanvas(d.w, d.h);                          // the 3D view's copy is at most 1024 wide
  if (pv.width !== e.preview.width || pv.height !== e.preview.height) { e.preview = pv; viewer.setTextureCanvas(pv); }
  showTexSize(e);
  fit();
}

// ---------------------------------------------------------------- mannequin (body from the user's GTA V)
const PROP_BONE = {
  p_head: 'head', p_eyes: 'head', p_ears: 'head', p_mouth: 'head', p_lhand: 'lHand', p_lwrist: 'lHand',
  p_rhand: 'rHand', p_rwrist: 'rHand', p_hip: 'pelvis', p_lfoot: 'lFoot', p_rfoot: 'rFoot',
};
const HIDE_FOR = { lowr: ['lowr'], feet: ['feet'], uppr: ['uppr'] }; // body slot the edited garment replaces

function updateBodyButton() {
  const b = $('#vBody');
  b.classList.toggle('on', S.bodyOn);
  b.title = S.gta ? (S.bodyOn ? t('Hide the body') : t('Show a ped body from your GTA V install'))
    : t('GTA V folder not found - click to set it');
}

async function applyBody(item) {
  if (!S.bodyOn) { viewer.showBody(false); return null; }
  let data = S.body[item.gender];
  if (!data) {
    try {
      setMsg(t('Reading GTA V body (first time can take a few seconds)…'));
      data = await api.bodyLoad(item.gender);
      S.body[item.gender] = data;
    } catch (e) {
      console.error(e);
      toast(t('Body unavailable: {error}', { error: e.message || e }), 'warn', 9000);
      S.bodyOn = false; updateBodyButton(); viewer.showBody(false);
      return null;
    }
  }
  if (viewer.bodyGender !== item.gender) { viewer.setBody(data); viewer.bodyGender = item.gender; }
  viewer.showBody(true);
  viewer.hideBodyParts(new Set(HIDE_FOR[item.comp] || []));
  return data;
}

async function toggleBody() {
  if (!S.gta) {
    const go = await modal({
      title: t('GTA V folder not found'),
      lines: [t('The body is read straight from your own GTA V install (legacy edition). Nothing is copied or saved.'), t('Choose the folder that contains GTA5.exe.')],
      buttons: [{ id: 'cancel', label: t('Cancel') }, { id: 'ok', label: t('Choose folder…'), accent: true }],
    });
    if (go !== 'ok') return;
    try {
      const dir = await api.bodySetDir();
      if (!dir) return;
      S.gta = dir;
    } catch (e) { toast(String(e.message || e), 'error', 9000); return; }
  }
  S.bodyOn = !S.bodyOn;
  try { localStorage.setItem('cs.body', S.bodyOn ? '1' : '0'); } catch { /* ignore */ }
  updateBodyButton();
  if (S.sel) await selectVariant(S.sel.item, S.sel.variant);
  else viewer.showBody(false);
}

// ---------------------------------------------------------------- select a piece
async function selectVariant(item, variant) {
  if (S.busy || dialogOpen()) return;                  // not while another piece is loading or a dialog (e.g. Save) is open
  if (!textSettle()) return;                           // text you are still typing goes onto the piece you typed it for
  S.busy = true;
  try {
    setMsg(t('Loading…'));
    let entry = S.docs.get(variant.ytd);
    if (!entry) {
      const tex = await api.loadTexture(variant.ytd);
      const doc = Paint.docFromRGBA(tex.width, tex.height, tex.rgba, t('Original'));
      entry = { item, variant, ytd: variant.ytd, doc, tex: { name: tex.name, format: tex.format, mips: tex.mips, width: tex.width, height: tex.height } };
      entry.preview = makePreviewCanvas(tex.width, tex.height);
      S.docs.set(variant.ytd, entry);
    }
    entry.item = item; entry.variant = variant; entry.ytd = variant.ytd;     // a cached painting always points at the current piece objects
    $('#world').style.visibility = ''; $('#handles').style.visibility = '';
    $('#btnOptions').hidden = false;

    let mesh = null;
    if (item.ydd) {
      mesh = S.meshes.get(item.ydd);
      if (!mesh) { mesh = await api.loadMesh(item.ydd); S.meshes.set(item.ydd, mesh); }
    }
    const drawable = mesh && mesh.drawables[0];
    if (!entry.uv && drawable) entry.uv = uvGuideCanvas(drawable, entry.doc.w, entry.doc.h);

    S.sel = entry;
    Paint.setDoc(entry.doc);
    if (!entry.doc.guide && entry.uv) { Paint.setGuide(entry.uv); entry.doc.guide.uv = true; applyGuideControls(); }     // .uv: this guide is the model's UV map, drawn again at the right size after a resize
    syncGuideControls();

    const bodyData = await applyBody(item);
    const bone = item.prop && bodyData ? (bodyData.bones[PROP_BONE[item.comp] || 'head'] || null) : null;
    viewer.setTextureCanvas(entry.preview);
    const tris = viewer.setMesh(drawable, item.prop, bone);
    Paint.flatInto(entry.preview);
    viewer.refresh();

    $('#current').textContent = currentLabel();
    showTexSize(entry);
    $('#empty').hidden = true; S.emptyMsg = null;
    S.last = { item, drawable: drawable || null, bone, bodyData, tris };
    updateViewInfo();
    pushPopout();
    fit();
    renderTree();
    const openRow = $('#tree .tree-item.sel');                      // keep the piece you opened in view
    if (openRow) openRow.scrollIntoView({ block: 'nearest' });
    setMsg(t('Editing {file}', { file: basename(variant.ytd) }));
  } catch (e) {
    console.error(e);
    toast(String(e.message || e), 'error', 9000);
    setMsg('');
  } finally {
    S.busy = false;
  }
}

/** The line under the 3D view: how big the model is, or why there is none. */
function updateViewInfo() {
  const l = S.last;
  $('#vInfo').textContent = !S.sel || !l ? ''
    : l.drawable ? tn(Math.round(l.tris), '{n} triangle · drag to orbit · wheel to zoom', '{n} triangles · drag to orbit · wheel to zoom', { n: Math.round(l.tris).toLocaleString(getLanguage()) })
      : t('No model found for this piece (texture only).');
}

// ---------------------------------------------------------------- live 3D update
let previewQueued = false;
function schedulePreview() {
  if (previewQueued || !S.sel) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    if (!S.sel) return;
    Paint.flatInto(S.sel.preview);
    viewer.refresh();
    queuePopTex();
  });
}

// ---------------------------------------------------------------- 3D view: full screen + pop-out window
/** The 3D panel takes over the whole window and the window itself goes full screen (Esc / F11 / the button leave). */
function setFull(on) {
  S.fs = !!on;
  const p = $('#viewerPanel');
  p.classList.toggle('fs', S.fs);
  $('#vFull').classList.toggle('on', S.fs);
  $('#vFull').textContent = S.fs ? t('Exit') : t('Full');
  if (api.setFullscreen) api.setFullscreen(S.fs).catch(() => { /* the panel still fills the window */ });
  requestAnimationFrame(() => viewer.resize());
}
const toggleFullscreen = () => setFull(!S.fs);

function updatePopButton() {
  const b = $('#vPop');
  b.classList.toggle('on', S.pop);
  b.title = S.pop ? t('Close the 3D pop-out window') : t('Open the 3D view in its own window - drag it to another monitor. It keeps updating live while you paint.');
}

/** Send the whole scene (mesh, body, which parts are hidden) to the pop-out. The body goes only once per gender. */
function pushPopout() {
  if (!S.pop || !S.last || !S.sel) return;
  const { item, drawable, bone, bodyData } = S.last;
  const m = {
    type: 'state', label: $('#current').textContent, mesh: drawable, isProp: !!item.prop, bone: bone || null,
    bodyOn: !!(S.bodyOn && bodyData), hide: S.bodyOn ? (HIDE_FOR[item.comp] || []) : [],
  };
  if (bodyData && S.popBody !== item.gender) { m.body = bodyData; S.popBody = item.gender; }
  api.viewerSend(m);
  sendPopTex();
}

function sendPopTex() {
  const e = S.sel;
  if (!S.pop || !e) return;
  const c = e.preview, px = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  api.viewerSend({ type: 'tex', width: c.width, height: c.height, rgba: px.data });
}

let popTimer = null, popAt = 0;
/** Stream the painted texture to the pop-out at most ~16 times a second; always the newest pixels. */
function queuePopTex() {
  if (!S.pop || popTimer) return;
  popTimer = setTimeout(() => { popTimer = null; popAt = performance.now(); sendPopTex(); }, Math.max(0, 60 - (performance.now() - popAt)));
}

function onPopMessage(m) {
  if (!m) return;
  if (m.type === 'ready') { S.pop = true; S.popBody = null; updatePopButton(); pushPopout(); }
  else if (m.type === 'closed') { S.pop = false; S.popBody = null; updatePopButton(); }
}

async function togglePopout() {
  if (S.pop) { await api.viewerClose(); return; }
  try {
    const r = await api.viewerOpen();
    if (r && r.blocked) toast(t('The pop-up window was blocked.'), 'warn');
    else if (r && !r.reused) {
      toast(r.onOther ? t('The 3D view is open on your other monitor. Double-click it (or press F11 there) for full screen.')
        : t('The 3D view is open in its own window. Drag it to your other monitor, then double-click it for full screen.'), 'ok', 7000);
    }
  } catch (e) { toast(t('Could not open the 3D window: {error}', { error: e.message || e }), 'error', 8000); }
}

let treeQueued = false;
function onChange(info) {
  schedulePreview();
  if (info && info.final) {
    refreshThumbs();
    if (!treeQueued) { treeQueued = true; setTimeout(() => { treeQueued = false; renderTree(); }, 150); }
    if (Paint.opts.tool === 'brush' || Paint.opts.tool === 'fill' || Paint.opts.tool === 'text' || ['line', 'rect', 'ellipse'].includes(Paint.opts.tool)) pushRecent(Paint.opts.color);
  }
}

// ---------------------------------------------------------------- layers panel
const LAYER_ICON = {
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
};
const iconSpan = (cls, svg) => { const s = el('span', cls); s.innerHTML = svg; return s; };   // the svg strings above are fixed, never user text

async function renameLayer(i) {
  const L = Paint.doc && Paint.doc.layers[i];
  if (!L) return;
  const v = await askText(t('Rename layer'), L.name);
  if (v && v.trim()) Paint.layerOp.set(i, 'name', v.trim());
}

function renderLayers() {
  const list = $('#layerList'), d = Paint.doc;
  list.textContent = '';
  if (!d) { syncLayerTools(); return; }
  for (let i = d.layers.length - 1; i >= 0; i--) {
    const L = d.layers[i], clipped = L.clip && i > 0;
    const row = el('div', 'layer' + (i === d.active ? ' active' : '') + (L.locked ? ' locked' : '') + (clipped ? ' clipped' : ''));
    if (clipped) {
      const mark = el('span', 'clipmark', '↳');
      mark.title = t('Clipped to the layer below: it only shows where that layer has pixels. Click to unclip.');
      mark.onclick = (e) => { e.stopPropagation(); Paint.layerOp.set(i, 'clip', false); };
      row.append(mark);
    }
    const eye = iconSpan('eye' + (L.visible ? '' : ' off'), L.visible ? LAYER_ICON.eye : LAYER_ICON.eyeOff);
    eye.title = L.visible ? t('Showing. Click to hide this layer.') : t('Hidden. Click to show this layer.');
    eye.onclick = (e) => { e.stopPropagation(); Paint.layerOp.set(i, 'visible', !L.visible); };
    const lock = iconSpan('lock' + (L.locked ? ' on' : ''), L.locked ? LAYER_ICON.lock : LAYER_ICON.unlock);
    lock.title = L.locked ? t('Locked. Click to unlock this layer.') : t('Click to lock this layer so it cannot be changed by accident.');
    lock.onclick = (e) => { e.stopPropagation(); Paint.layerOp.set(i, 'locked', !L.locked); };
    const th = document.createElement('canvas');
    th.width = 42; th.height = 30; th.dataset.layer = i;
    const name = el('span', 'lname', L.name);
    name.title = t('Double-click to rename');
    name.ondblclick = () => renameLayer(i);
    row.onclick = () => Paint.layerOp.select(i);
    row.append(eye, lock, th, name);
    if (L.text) {                                           // live text: still editable
      const tb = el('span', 'tbadge', 'T');
      tb.title = t('Live text. Double-click it to edit, or click the text on the texture with the Text tool (T).');
      tb.ondblclick = th.ondblclick = (e) => { e.stopPropagation(); textEditLayer(i); };
      row.append(tb);
    }
    list.append(row);
  }
  refreshThumbs();
  const A = d.layers[d.active];
  $('#lOpacity').value = Math.round(A.opacity * 100);
  $('#lOpacityV').textContent = Math.round(A.opacity * 100);
  $('#lBlend').value = A.blend;
  syncLayerTools();
  const act = list.querySelector('.layer.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

/** The big buttons above the layer list: what each one does right now (and whether it can). */
function syncLayerTools() {
  const d = Paint.doc, A = d && d.layers[d.active], n = d ? d.layers.length : 0, i = d ? d.active : 0;
  const off = (id, v) => { $(id).disabled = !!v; };
  off('#lAdd', !d); off('#lDup', !A); off('#lUp', !A || i >= n - 1); off('#lDown', !A || i <= 0);
  off('#lLock', !A); off('#lMerge', !A || i === 0); off('#lRename', !A); off('#lDel', !A);
  const locked = !!(A && A.locked);
  $('#lLock').classList.toggle('on', locked);
  $('#lLock span').textContent = locked ? t('Unlock') : t('Lock');
  $('#lLock svg').innerHTML = (locked ? LAYER_ICON.lock : LAYER_ICON.unlock).replace(/^<svg[^>]*>|<\/svg>$/g, '');
  $('#lLock').title = locked ? t('Unlock the selected layer so it can be painted on, moved and deleted again') : t('Lock the selected layer so it cannot be painted on, moved, resized, merged or deleted by accident');
  $('#lDel span').textContent = n === 1 ? t('Clear') : t('Delete');
  $('#lDel').title = n === 1 ? t('Erase everything on the only layer (Undo brings it back)') : t('Delete the selected layer (Undo brings it back)');
  $('#lMerge').title = A && i > 0 ? t('Merge: join the selected layer into "{name}" below it, so they become one layer (Ctrl+E)', { name: d.layers[i - 1].name }) : t('Merge: there is no layer below to join this one into');
  $('#lUp').title = A && i >= n - 1 ? t('Up: this is already the top layer') : t('Move the selected layer up, in front of the one above it (Ctrl+])');
  $('#lDown').title = A && i <= 0 ? t('Down: this is already the bottom layer') : t('Move the selected layer down, behind the one below it (Ctrl+[)');
  $('#lDup').title = t('Duplicate: make a copy of the selected layer (Ctrl+J). A text layer stays editable.');
  $('#lCount').textContent = d ? `(${n})` : '';
  const clip = $('#lClip'), clipped = !!(A && A.clip && i > 0);
  clip.disabled = !A || i === 0;
  clip.classList.toggle('on', clipped);
  clip.title = !A || i === 0 ? t('Clip: the bottom layer has nothing below it to clip to')
    : clipped ? t('Clipped: "{name}" only shows where the layer below has pixels. Click to unclip (Ctrl+G).', { name: A.name })
      : t('Clip to the layer below: "{name}" then only shows where that layer has pixels, like a clipping mask in Photoshop (Ctrl+G)', { name: A.name });
  $('#lFabric').disabled = !A;
}

function refreshThumbs() {
  const d = Paint.doc;
  if (!d) return;
  for (const th of $$('#layerList canvas')) {
    const L = d.layers[+th.dataset.layer];
    if (!L) continue;
    const g = th.getContext('2d');
    g.clearRect(0, 0, th.width, th.height);
    g.drawImage(L.canvas, 0, 0, th.width, th.height);
  }
}

// ---------------------------------------------------------------- view (zoom / pan)
function applyView() {
  const w = $('#world'), d = Paint.doc;
  if (!d) return;
  w.style.width = d.w + 'px'; w.style.height = d.h + 'px';
  w.style.transform = `translate(${S.panX}px,${S.panY}px) scale(${S.zoom})`;
  w.classList.toggle('pixel', S.zoom >= 2.5);
  $('#stZoom').textContent = Math.round(S.zoom * 100) + '%';
  drawHandles();
  if (S.text) textRefresh();                       // the text editor follows the canvas when you zoom or pan
}

function fit() {
  const vp = $('#viewport'), d = Paint.doc;
  if (!d) return;
  if (vp.clientWidth < 120 || vp.clientHeight < 120) { S.needFit = true; return; } // not laid out yet; retried on resize
  S.needFit = false;
  const k = Math.min((vp.clientWidth - 40) / d.w, (vp.clientHeight - 40) / d.h);
  S.zoom = clamp(k, 0.05, 8);
  S.panX = (vp.clientWidth - d.w * S.zoom) / 2;
  S.panY = (vp.clientHeight - d.h * S.zoom) / 2;
  applyView();
}

function zoomAt(f, cx, cy) {
  const r = $('#viewport').getBoundingClientRect();
  const mx = cx - r.left, my = cy - r.top;
  const nz = clamp(S.zoom * f, 0.05, 32), k = nz / S.zoom;
  S.panX = mx - (mx - S.panX) * k; S.panY = my - (my - S.panY) * k; S.zoom = nz;
  applyView();
}

function toDoc(e) {
  const r = $('#world').getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom };
}

function updateCursor(e) {
  const c = $('#cursor'), t = Paint.opts.tool;
  if (!Paint.doc || !['brush', 'eraser'].includes(t) || S.space || S.panning) { c.style.display = 'none'; return; }
  const vp = $('#viewport').getBoundingClientRect();
  const size = Math.max(4, Paint.opts.size * S.zoom);
  c.style.display = 'block';
  c.style.width = c.style.height = size + 'px';
  c.style.left = (e.clientX - vp.left) + 'px';
  c.style.top = (e.clientY - vp.top) + 'px';
}

function wireViewport() {
  const vp = $('#viewport');
  vp.addEventListener('contextmenu', (e) => e.preventDefault());

  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!Paint.doc) return;
    if (Paint.opts.tool === 'move' && !e.ctrlKey) {
      const p = toDoc(e);
      Paint.scaleActive(e.deltaY < 0 ? 1.04 : 1 / 1.04, p.x, p.y);
      return;
    }
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false });

  // the Text tool: keep the browser from moving focus away from the text box when you click on the canvas
  vp.addEventListener('mousedown', (e) => {
    if (Paint.opts.tool === 'text' && !e.altKey && e.button === 0 && !e.target.closest('#textBox, #textGrip')) e.preventDefault();
  });

  vp.addEventListener('pointerdown', (e) => {
    if (!Paint.doc || !S.sel) return;
    if (e.target.closest && e.target.closest('#textBox, #textGrip')) return;      // the text editor handles its own clicks
    if (e.button === 1 || (e.button === 0 && S.space)) {
      S.panning = { x: e.clientX, y: e.clientY, px: S.panX, py: S.panY };
      vp.setPointerCapture(e.pointerId);
      vp.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    if (Paint.opts.tool === 'transform') { xfDown(e); return; }
    if (Paint.opts.tool === 'text' && !e.altKey) { textDown(e); return; }
    vp.setPointerCapture(e.pointerId);
    if (e.altKey && Paint.opts.tool !== 'eyedrop') { S.altTool = Paint.opts.tool; Paint.opts.tool = 'eyedrop'; }
    S.stroking = true;
    const p = toDoc(e);
    Paint.down({ x: p.x, y: p.y, pressure: e.pointerType === 'pen' ? Math.max(0.1, e.pressure) : 1 }, { shift: e.shiftKey });
  });

  vp.addEventListener('pointermove', (e) => {
    updateCursor(e);
    if (Paint.doc) {
      const p = toDoc(e);
      $('#stPos').textContent = `${Math.floor(p.x)}, ${Math.floor(p.y)}`;
    }
    if (S.panning) {
      S.panX = S.panning.px + (e.clientX - S.panning.x);
      S.panY = S.panning.py + (e.clientY - S.panning.y);
      applyView();
      return;
    }
    if (S.xfDrag) { xfMove(e); return; }
    if (Paint.opts.tool === 'transform' && Paint.doc) { xfHover(e); return; }
    if (!S.stroking) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of (evs.length ? evs : [e])) {
      const p = toDoc(ce);
      Paint.move({ x: p.x, y: p.y, pressure: e.pointerType === 'pen' ? Math.max(0.1, ce.pressure) : 1 }, { shift: e.shiftKey });
    }
  });

  const end = (e) => {
    if (S.panning) { S.panning = null; vp.style.cursor = ''; return; }
    if (S.xfDrag) { xfUp(e); return; }
    if (!S.stroking) return;
    S.stroking = false;
    const p = toDoc(e);
    Paint.up({ x: p.x, y: p.y }, { shift: e.shiftKey });
    if (S.altTool) { Paint.opts.tool = S.altTool; S.altTool = null; }
  };
  vp.addEventListener('pointerup', end);
  vp.addEventListener('pointercancel', end);
  vp.addEventListener('pointerleave', () => { $('#cursor').style.display = 'none'; });
  new ResizeObserver(() => {
    if (!Paint.doc) return;
    if (S.needFit) fit(); else applyView();
  }).observe(vp);
}

// ---------------------------------------------------------------- resize tool (move / scale / rotate / flip a layer)
const HANDLE_PX = 9;   // grab radius of a resize handle, in screen pixels
const ROT_DIST = 30;   // distance of the rotate knob above the box, in screen pixels

/** Corners, edge midpoints and the rotate knob of the box, in viewport (screen) pixels. */
function xfGeom(st) {
  const a = (st.bw * st.sx) / 2, b = (st.bh * st.sy) / 2, co = Math.cos(st.rot), si = Math.sin(st.rot);
  const scr = (lx, ly) => ({ x: (st.cx + lx * co - ly * si) * S.zoom + S.panX, y: (st.cy + lx * si + ly * co) * S.zoom + S.panY });
  const dirs = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]]; // corners first so they win when handles overlap
  const handles = dirs.map(([hx, hy]) => ({ h: [hx, hy], ...scr(hx * a, hy * b) }));
  const top = scr(0, -b);
  return { a, b, co, si, handles, top, knob: { x: top.x + si * ROT_DIST, y: top.y - co * ROT_DIST } };
}

function xfLocal(st, p) { // document point -> the layer's own (rotated) frame, relative to its centre
  const dx = p.x - st.cx, dy = p.y - st.cy, co = Math.cos(st.rot), si = Math.sin(st.rot);
  return { x: dx * co + dy * si, y: -dx * si + dy * co };
}

function xfHit(st, e) {
  const r = $('#viewport').getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  const g = xfGeom(st);
  if (Math.hypot(px - g.knob.x, py - g.knob.y) <= HANDLE_PX + 3) return { mode: 'rotate' };
  for (const h of g.handles) if (Math.hypot(px - h.x, py - h.y) <= HANDLE_PX) return { mode: 'scale', h: h.h };
  const lp = xfLocal(st, { x: (px - S.panX) / S.zoom, y: (py - S.panY) / S.zoom });
  if (Math.abs(lp.x) <= g.a && Math.abs(lp.y) <= g.b) return { mode: 'move' };
  const out = Math.hypot(Math.max(Math.abs(lp.x) - g.a, 0), Math.max(Math.abs(lp.y) - g.b, 0)) * S.zoom;
  return out < 28 ? { mode: 'rotate' } : null;
}

function xfCursor(st, hit) {
  if (!hit) return 'default';
  if (hit.mode === 'move') return 'move';
  if (hit.mode === 'rotate') return 'grab';
  const deg = ((Math.atan2(hit.h[1], hit.h[0]) + st.rot) * 180) / Math.PI;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round((((deg % 180) + 180) % 180) / 45) % 4];
}

function xfHover(e) {
  const st = Paint.xformState();
  $('#viewport').style.cursor = st ? xfCursor(st, xfHit(st, e)) : 'default';
}

function xfDown(e) {
  let st = Paint.xformState();
  if (!st) { ensureTransform(true); st = Paint.xformState(); }
  if (!st) return;
  const hit = xfHit(st, e);
  if (!hit) return;
  $('#viewport').setPointerCapture(e.pointerId);
  S.xfDrag = { mode: hit.mode, h: hit.h, start: st, p0: toDoc(e), moved: false };
  if (hit.mode === 'rotate') $('#viewport').style.cursor = 'grabbing';
}

function xfMove(e) {
  const d = S.xfDrag, s = d.start, p = toDoc(e);
  d.moved = true;
  if (d.mode === 'move') {
    let dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    Paint.xformSet({ cx: s.cx + Math.round(dx), cy: s.cy + Math.round(dy) });
  } else if (d.mode === 'rotate') {
    const a0 = Math.atan2(d.p0.y - s.cy, d.p0.x - s.cx), a1 = Math.atan2(p.y - s.cy, p.x - s.cx);
    let rot = s.rot + (a1 - a0);
    if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
    Paint.xformSet({ rot });
  } else {
    const [hx, hy] = d.h, W = s.bw * s.sx, H = s.bh * s.sy, co = Math.cos(s.rot), si = Math.sin(s.rot);
    const lp = xfLocal(s, p), alt = e.altKey, m = alt ? 2 : 1;
    const Ax = alt ? 0 : (-hx * W) / 2, Ay = alt ? 0 : (-hy * H) / 2; // the point that stays put
    let nW = W, nH = H;
    if (hx && hy && $('#xLock').checked !== e.shiftKey) {
      const dxd = hx * W, dyd = hy * H;
      let k = (m * ((lp.x - Ax) * dxd + (lp.y - Ay) * dyd)) / (dxd * dxd + dyd * dyd);
      k = Math.max(k, 4 / Math.min(W, H));
      nW = W * k; nH = H * k;
    } else {
      if (hx) nW = Math.max(4, m * hx * (lp.x - Ax));
      if (hy) nH = Math.max(4, m * hy * (lp.y - Ay));
    }
    const ox = !alt && hx ? Ax + (hx * nW) / 2 : 0, oy = !alt && hy ? Ay + (hy * nH) / 2 : 0;
    Paint.xformSet({ cx: s.cx + ox * co - oy * si, cy: s.cy + ox * si + oy * co, sx: nW / s.bw, sy: nH / s.bh });
  }
}

function xfUp(e) {
  const moved = S.xfDrag && S.xfDrag.moved;
  S.xfDrag = null;
  refreshThumbs();
  if (moved) renderTree();
  const st = Paint.xformState();
  $('#viewport').style.cursor = st ? xfCursor(st, xfHit(st, e)) : 'default';
}

/** Open a resize session on the active layer if the Resize tool is selected. */
function ensureTransform(announce) {
  if (Paint.opts.tool !== 'transform' || !Paint.doc || Paint.xformState()) return;
  const ok = Paint.xformBegin();
  if (!ok && announce) {
    const L = Paint.doc.layers[Paint.doc.active];
    toast(L.locked ? t('This layer is locked. Unlock it (padlock in the Layers list) to resize it.')
      : !L.visible ? t('This layer is hidden. Show it to resize it.')
        : t('This layer has nothing on it yet, so there is nothing to resize. Pick a layer with an image, or import one.'), 'warn', 6000);
  }
}

function drawHandles() {
  const cv = $('#handles'), vp = $('#viewport'), dpr = window.devicePixelRatio || 1;
  const w = vp.clientWidth, h = vp.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const st = Paint.doc && Paint.opts.tool === 'transform' ? Paint.xformState() : null;
  if (!st) return;
  const geo = xfGeom(st), c = geo.handles.slice(0, 4);
  g.lineJoin = 'round';
  const outline = () => { g.beginPath(); c.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); };
  g.strokeStyle = '#000a'; g.lineWidth = 3.5; outline(); g.stroke();
  g.strokeStyle = '#4d8dff'; g.lineWidth = 1.5; outline(); g.stroke();
  g.beginPath(); g.moveTo(geo.top.x, geo.top.y); g.lineTo(geo.knob.x, geo.knob.y);
  g.strokeStyle = '#000a'; g.lineWidth = 3.5; g.stroke(); g.strokeStyle = '#4d8dff'; g.lineWidth = 1.5; g.stroke();
  for (const p of geo.handles) {
    g.fillStyle = '#fff'; g.strokeStyle = '#1b3a78'; g.lineWidth = 1.5;
    g.beginPath(); g.rect(p.x - 5, p.y - 5, 10, 10); g.fill(); g.stroke();
  }
  g.beginPath(); g.arc(geo.knob.x, geo.knob.y, 6, 0, Math.PI * 2);
  g.fillStyle = '#4d8dff'; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
}

function syncXformUi() {
  const st = Paint.doc ? Paint.xformState() : null;
  const bar = $('#xfBar');
  for (const c of bar.querySelectorAll('input,button')) c.disabled = !st;
  if (st) {
    const put = (id, v) => { const i = $(id); if (document.activeElement !== i) i.value = v; };
    put('#xW', Math.round(st.bw * st.sx)); put('#xH', Math.round(st.bh * st.sy)); put('#xS', Math.round(st.sx * 100));
    let deg = (st.rot * 180) / Math.PI; deg = ((((deg + 180) % 360) + 360) % 360) - 180;
    put('#xA', Math.round(deg * 10) / 10);
  }
  let note = '';
  if (!st && Paint.doc && Paint.opts.tool === 'transform') {
    const L = Paint.doc.layers[Paint.doc.active];
    note = L.locked ? t('This layer is locked.') : !L.visible ? t('This layer is hidden.') : t('This layer is empty - nothing to resize.');
  }
  $('#xfNote').textContent = note;
  drawHandles();
}

function wireTransformBar() {
  const num = (id, fn) => $(id).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value), st = Paint.xformState();
    if (isFinite(v) && st) fn(v, st);
  });
  const lock = () => $('#xLock').checked;
  num('#xW', (v, st) => { const sx = clamp(v, 1, 16384) / st.bw; Paint.xformSet({ sx, sy: lock() ? (st.sy * sx) / st.sx : st.sy }); });
  num('#xH', (v, st) => { const sy = clamp(v, 1, 16384) / st.bh; Paint.xformSet({ sy, sx: lock() ? (st.sx * sy) / st.sy : st.sx }); });
  num('#xS', (v, st) => { const sx = clamp(v, 1, 3000) / 100; Paint.xformSet({ sx, sy: (st.sy * sx) / st.sx }); });
  num('#xA', (v) => Paint.xformSet({ rot: (v * Math.PI) / 180 }));

  const act = (fn) => (e) => { const st = Paint.xformState(); if (st) fn(st, Paint.doc); e.currentTarget.blur(); };
  const final = (patch) => Paint.xformSet(patch, true);
  $('#xFlipH').onclick = act((st) => final({ fx: -st.fx }));
  $('#xFlipV').onclick = act((st) => final({ fy: -st.fy }));
  $('#xFit').onclick = act((st, d) => { const k = Math.min(d.w / st.bw, d.h / st.bh); final({ sx: k, sy: k, rot: 0, cx: d.w / 2, cy: d.h / 2 }); });
  $('#xFill').onclick = act((st, d) => { const k = Math.max(d.w / st.bw, d.h / st.bh); final({ sx: k, sy: k, rot: 0, cx: d.w / 2, cy: d.h / 2 }); });
  $('#xStretch').onclick = act((st, d) => final({ sx: d.w / st.bw, sy: d.h / st.bh, rot: 0, cx: d.w / 2, cy: d.h / 2 }));
  $('#xReset').onclick = act((st) => final({ sx: 1, sy: 1, rot: 0, fx: 1, fy: 1, cx: st.home.cx, cy: st.home.cy }));
  $('#xApply').onclick = (e) => { applyTransform(); e.currentTarget.blur(); };
  $('#xCancel').onclick = (e) => { cancelTransform(); e.currentTarget.blur(); };
}

function applyTransform() { Paint.xformEnd(true); ensureTransform(); }
function cancelTransform() { Paint.xformEnd(false); ensureTransform(); }

// ---------------------------------------------------------------- text tool
// Click on the texture and type. The text appears exactly as it will be painted (the preview is drawn by the same code that
// paints it). It lives on its own layer and stays editable: click it again with the Text tool to retype it, restyle it, mirror it...
const TXT = {
  family: 'Arial', size: 96, bold: false, italic: false, underline: false, strike: false, caps: false, align: 'left',
  spacing: 0, leading: 120, rot: 0, flipH: false, flipV: false,
  stroke: 0, strokeColor: '#ffffff', shadow: false, shadowColor: '#000000', shadowBlur: 8, shadowX: 6, shadowY: 6,
};
const TXT_BOOL = ['bold', 'italic', 'underline', 'strike', 'caps', 'flipH', 'flipV', 'shadow'];
const TXT_NUM = { size: [6, 2000], spacing: [-50, 300], leading: [50, 400], rot: [-360, 360], stroke: [0, 80], shadowBlur: [0, 100], shadowX: [-200, 200], shadowY: [-200, 200] };
const TEXT_FONTS = [
  'Arial', 'Arial Black', 'Arial Narrow', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Century Gothic', 'Comic Sans MS', 'Consolas', 'Constantia',
  'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact', 'Ink Free', 'Lucida Console', 'Lucida Handwriting',
  'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Black', 'Sylfaen', 'Tahoma',
  'Times New Roman', 'Trebuchet MS', 'Verdana', 'Algerian', 'Bauhaus 93', 'Berlin Sans FB', 'Bradley Hand ITC', 'Broadway', 'Brush Script MT', 'Castellar',
  'Chiller', 'Colonna MT', 'Copperplate Gothic Bold', 'Curlz MT', 'Edwardian Script ITC', 'Elephant', 'Engravers MT', 'Forte', 'Freestyle Script',
  'Gill Sans MT', 'Goudy Stout', 'Haettenschweiler', 'Harrington', 'Jokerman', 'Kristen ITC', 'Magneto', 'Mistral', 'Old English Text MT', 'Onyx',
  'Playbill', 'Rockwell', 'Showcard Gothic', 'Snap ITC', 'Stencil', 'Tempus Sans ITC', 'Vivaldi', 'Wide Latin',
  'Helvetica', 'Roboto', 'Open Sans', 'Montserrat', 'Oswald', 'Bebas Neue', 'Anton', 'Lato', 'Poppins', 'Permanent Marker', 'Pacifico', 'Lobster',
];
let textPrev = null;                       // canvas inside the zoomed canvas that shows the text as it will be painted
let fontNamesP = null;

/** Copy settings into TXT, ignoring anything missing or out of range. */
function setTxt(p) {
  if (typeof p.family === 'string' && p.family.trim() && p.family.length < 80) TXT.family = p.family.trim();
  for (const [k, [a, b]] of Object.entries(TXT_NUM)) if (Number.isFinite(p[k])) TXT[k] = clamp(Math.round(p[k] * 100) / 100, a, b);   // Move / Resize can leave fractions (a text made 1.37 times bigger)
  for (const k of TXT_BOOL) if (typeof p[k] === 'boolean') TXT[k] = p[k];
  for (const k of ['strokeColor', 'shadowColor']) if (/^#[0-9a-f]{6}$/i.test(p[k])) TXT[k] = p[k];
  if (['left', 'center', 'right'].includes(p.align)) TXT.align = p.align;
}
function loadTextPrefs() {
  try { setTxt(JSON.parse(localStorage.getItem('cs.text2') || '{}')); } catch { /* first run, or storage unavailable */ }
}
function saveTextPrefs() {
  if (window.__noPrefs) return;                      // the developer self-tests must not leave their settings in your profile
  try { localStorage.setItem('cs.text2', JSON.stringify(TXT)); } catch { /* ignore */ }
}

/** The complete description of the text being edited: what is stored on the layer and what Paint.drawText paints. */
function textOpts() {
  return {
    text: S.text ? S.text.ta.value : '', family: TXT.family, size: TXT.size, bold: TXT.bold, italic: TXT.italic, underline: TXT.underline,
    strike: TXT.strike, caps: TXT.caps, align: TXT.align, spacing: TXT.spacing, leading: TXT.leading / 100, rot: TXT.rot, flipH: TXT.flipH, flipV: TXT.flipV,
    color: Paint.opts.color, opacity: Paint.opts.opacity, stroke: TXT.stroke, strokeColor: TXT.strokeColor,
    shadow: TXT.shadow, shadowColor: TXT.shadowColor, shadowBlur: TXT.shadowBlur, shadowX: TXT.shadowX, shadowY: TXT.shadowY,
  };
}

function syncTextUi() {
  $('#oFontName').textContent = TXT.family;
  $('#oFontName').style.fontFamily = Paint.quoteFamily(TXT.family);
  for (const [id, key] of [['#oFontSize', 'size'], ['#oSpacing', 'spacing'], ['#oLeading', 'leading'], ['#oAngle', 'rot'], ['#oStroke', 'stroke'],
    ['#oShadowBlur', 'shadowBlur'], ['#oShadowX', 'shadowX'], ['#oShadowY', 'shadowY']]) {
    const inp = $(id);
    if (document.activeElement !== inp) inp.value = TXT[key];              // do not fight the number you are typing
  }
  $('#oStrokeColor').value = TXT.strokeColor;
  $('#oShadowColor').value = TXT.shadowColor;
  $('#oShadow').checked = TXT.shadow;
  for (const [id, key] of [['#oBold', 'bold'], ['#oItalic', 'italic'], ['#oUnder', 'underline'], ['#oStrike', 'strike'], ['#oCaps', 'caps'], ['#oFlipH', 'flipH'], ['#oFlipV', 'flipV']]) {
    $(id).classList.toggle('on', TXT[key]);
  }
  for (const b of $$('[data-align]')) b.classList.toggle('on', b.dataset.align === TXT.align);
  const d = Paint.doc, A = d && d.layers[d.active];
  $('#oTextApply').disabled = $('#oTextCancel').disabled = !S.text;
  $('#oTextEdit').disabled = !!S.text || !(A && A.text && A.visible && !A.locked);
}

/** Keeps the text box and its preview in step with the zoom, pan, font, colour and everything you typed. */
function textRefresh() {
  const T = S.text, d = Paint.doc;
  if (!T || !d || !textPrev) return;
  const o = textOpts(), z = S.zoom, ta = T.ta;
  T.layout = Paint.textLayout(o);
  ta.style.font = Paint.textFont({ ...o, size: o.size * z });
  ta.style.lineHeight = String(o.leading);
  ta.style.letterSpacing = (o.spacing * z) + 'px';
  ta.style.textTransform = o.caps ? 'uppercase' : 'none';
  ta.style.textAlign = o.align;
  const extra = 8, shift = o.align === 'center' ? extra / 2 : o.align === 'right' ? extra : 0;   // a little room for the caret
  const left = S.panX + T.x * z - shift, top = S.panY + T.y * z;
  ta.style.left = left + 'px'; ta.style.top = top + 'px';
  ta.style.width = Math.ceil(T.layout.w * z + extra) + 'px'; ta.style.height = Math.ceil(T.layout.h * z) + 'px';
  // the box is turned and mirrored about its middle, exactly like the painted text, so the caret and the selection follow the letters
  ta.style.transformOrigin = `${shift + (T.layout.w * z) / 2}px ${(T.layout.h * z) / 2}px`;
  ta.style.transform = o.rot || o.flipH || o.flipV ? `rotate(${o.rot}deg) scale(${o.flipH ? -1 : 1}, ${o.flipV ? -1 : 1})` : 'none';
  const grip = $('#textGrip');
  grip.style.left = Math.max(2, left - 26) + 'px'; grip.style.top = Math.max(2, top - 26) + 'px';
  const g = textPrev.getContext('2d');
  g.clearRect(0, 0, textPrev.width, textPrev.height);
  if (o.text) Paint.drawText(g, o, T.x, T.y);
}

/** Opens the editor at (x, y). With layerIndex it edits that text layer instead of starting a new text. */
function textBegin(x, y, layerIndex) {
  const d = Paint.doc;
  if (!d) return;
  if (!textPrev) { textPrev = document.createElement('canvas'); textPrev.id = 'textPreview'; $('#world').append(textPrev); }
  textPrev.width = d.w; textPrev.height = d.h;
  const ta = $('#textBox');
  const L = layerIndex == null ? null : d.layers[layerIndex];
  ta.value = L ? L.text.text : '';
  S.text = { x: Math.round(x), y: Math.round(y), ta, layout: null, drag: null, layer: L };
  if (L) Paint.setEditing(layerIndex, true);               // its pixels are hidden while the live preview stands in for them
  ta.hidden = false; $('#textGrip').hidden = false;
  syncTextUi();
  textRefresh();
  setTimeout(() => { if (S.text) ta.focus(); }, 0);        // after the click has finished, so it keeps the focus
}

/** Opens an existing text layer for editing: its text, font, style and colour come back exactly as they were painted. */
function textEditLayer(index) {
  const d = Paint.doc, L = d && d.layers[index];
  if (!L || !L.text) return false;
  if (L.locked) { toast(t('That text layer is locked. Unlock it (padlock in the Layers list) to change the text.'), 'warn'); return false; }
  if (!L.visible) { toast(t('That text layer is hidden. Show it first.'), 'warn'); return false; }
  if (!textSettle()) return false;
  const i = d.layers.indexOf(L);                           // placing text that was still open may have added a layer above
  if (i < 0) return false;
  if (Paint.opts.tool !== 'text') setTool('text');
  Paint.layerOp.select(i);
  const m = L.text;
  setTxt({ ...m, leading: Math.round((m.leading || 1.2) * 100) });
  setColor(m.color, false);
  const op = $('#oOpac'); op.value = Math.round((m.opacity == null ? 1 : m.opacity) * 100); op.dispatchEvent(new Event('input'));
  textBegin(m.x, m.y, i);
  setMsg(t('Editing the text: type, or change the font and style above. Ctrl+Enter or a click elsewhere keeps it · Esc throws your changes away'));
  return true;
}

/** Places (commit) or throws away the open text. Returns false when it could not be placed, e.g. the layer was locked meanwhile. */
function textEnd(commit) {
  const T = S.text;
  if (!T) return true;
  const d = Paint.doc, o = textOpts();
  if (T.layer) {                                            // editing a text layer that already exists
    const i = d ? d.layers.indexOf(T.layer) : -1;
    if (i >= 0) {
      if (commit) {
        if (!Paint.updateTextLayer(i, o, T.x, T.y)) return false;
        if (!String(o.text).trim()) toast(t('The text was empty, so its layer was removed. Undo (Ctrl+Z) brings it back.'), 'info', 6000);
      } else Paint.setEditing(i, false);
    }
    T.layer.editing = false;
  } else if (commit && String(o.text).trim()) {
    Paint.addTextLayer(o, T.x, T.y);
  }
  S.text = null;
  T.ta.hidden = true; T.ta.value = ''; $('#textGrip').hidden = true;
  if (textPrev) textPrev.getContext('2d').clearRect(0, 0, textPrev.width, textPrev.height);
  syncTextUi();
  return true;
}
const textSettle = () => !S.text || textEnd(true);

/** Index of the topmost visible, unlocked text layer whose text is under the document point (px, py), or -1. */
function textHit(px, py) {
  const d = Paint.doc;
  if (!d) return -1;
  const pad = Math.max(6, 8 / S.zoom);
  for (let i = d.layers.length - 1; i >= 0; i--) {
    const L = d.layers[i], m = L.text;
    if (!m || !L.visible || L.locked) continue;
    const lay = Paint.textLayout(m), a = (-(m.rot || 0) * Math.PI) / 180;
    const dx = px - (m.x + lay.w / 2), dy = py - (m.y + lay.h / 2);
    const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);   // the point, turned back into the text's own frame
    if (Math.abs(lx) <= lay.w / 2 + pad && Math.abs(ly) <= lay.h / 2 + pad) return i;
  }
  return -1;
}

function textDown(e) {
  const p = toDoc(e);
  if (!textSettle()) return;
  const i = textHit(p.x, p.y);
  if (i >= 0) textEditLayer(i);                             // clicking text you already placed opens it again
  else textBegin(p.x, p.y - TXT.size * 0.6);                // a new text: the click lands in the middle of the first line
}

let fontProbe = null;
function fontInstalled(name) {
  if (!fontProbe) fontProbe = document.createElement('canvas').getContext('2d');
  const t = 'mmmmmmmmmmlliWW@#0O';
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    fontProbe.font = `72px ${base}`; const w0 = fontProbe.measureText(t).width;
    fontProbe.font = `72px "${name.replace(/["\\]/g, '')}", ${base}`;
    if (fontProbe.measureText(t).width !== w0) return true;
  }
  return false;
}

function textFontNames() {
  if (!fontNamesP) {
    fontNamesP = (async () => {
      const set = new Set(TEXT_FONTS.filter(fontInstalled));
      try {
        if (window.queryLocalFonts && api.isDesktop) {          // every font installed on this PC (Electron only; the curated list above is the fallback)
          const all = await Promise.race([window.queryLocalFonts(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))]);
          for (const f of all) if (f.family) set.add(f.family);
        }
      } catch { /* not allowed or too slow: the curated list is enough */ }
      for (const f of S.customFonts) set.add(f);
      return [...set].sort((a, b) => a.localeCompare(b));
    })();
  }
  return fontNamesP;
}

function closeFontMenu() {
  const m = $('#fontMenu');
  if (m) m.remove();
  document.removeEventListener('pointerdown', onFontMenuOutside, true);
}
function onFontMenuOutside(e) {
  const m = $('#fontMenu');
  if (m && !m.contains(e.target) && !e.target.closest('#oFont')) closeFontMenu();
}

function chooseFont(name) {
  TXT.family = name;
  closeFontMenu(); syncTextUi(); saveTextPrefs(); textRefresh();
  if (S.text) S.text.ta.focus();
}

async function openFontMenu() {
  closeFontMenu();
  const names = await textFontNames();
  if ($('#fontMenu')) return;                               // a second click got here first
  const btn = $('#oFont'), r = btn.getBoundingClientRect();
  const m = el('div'); m.id = 'fontMenu';
  const q = el('input'); q.type = 'search'; q.placeholder = t('Search, or type any font name…'); q.spellcheck = false; q.autocomplete = 'off';
  const list = el('div', 'fm-list');
  m.append(q, list);
  let shown = [], hot = 0;
  const render = () => {
    const f = q.value.trim().toLowerCase();
    shown = names.filter((n) => n.toLowerCase().includes(f));
    hot = clamp(hot, 0, Math.max(0, shown.length - 1));
    list.textContent = '';
    shown.forEach((n, i) => {
      const it = el('div', 'fm-item' + (n === TXT.family ? ' cur' : '') + (i === hot ? ' hot' : ''), n);
      it.style.fontFamily = Paint.quoteFamily(n);
      it.onmousedown = (ev) => { ev.preventDefault(); chooseFont(n); };
      list.append(it);
    });
    if (f && !shown.some((n) => n.toLowerCase() === f)) {
      const typed = q.value.trim();
      list.append(el('div', 'fm-custom', fontInstalled(typed) ? t('Enter = use "{font}" as typed', { font: typed }) : t('Enter = use "{font}" as typed (not found on this PC, so a default font shows)', { font: typed })));
    }
  };
  q.oninput = () => { hot = 0; render(); };
  q.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFontMenu(); if (S.text) S.text.ta.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); hot = clamp(hot + (e.key === 'ArrowDown' ? 1 : -1), 0, Math.max(0, shown.length - 1)); render();
      const h = list.querySelector('.hot'); if (h) h.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const typed = q.value.trim();
      if (typed && !shown.length) chooseFont(typed);        // not in the list: use the name exactly as typed
      else if (shown.length) chooseFont(shown[hot]);
    }
  };
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 292)) + 'px';
  m.style.top = (r.bottom + 4) + 'px';
  m.style.maxHeight = Math.max(180, Math.min(440, window.innerHeight - r.bottom - 16)) + 'px';
  document.body.append(m);
  document.addEventListener('pointerdown', onFontMenuOutside, true);
  render();
  q.focus();
  const cur = list.querySelector('.cur'); if (cur) cur.scrollIntoView({ block: 'center' });
}

async function loadFontFile(file) {
  try {
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || t('Custom font');
    const ff = new FontFace(name, await file.arrayBuffer());
    await ff.load();
    document.fonts.add(ff);
    if (!S.customFonts.includes(name)) S.customFonts.push(name);
    fontNamesP = null;
    chooseFont(name);
    toast(t('Loaded the font "{name}". It stays available until you close the app.', { name }), 'ok', 4000);
  } catch (err) {
    toast(t('That font file could not be loaded: {error}', { error: String(err.message || err) }), 'error', 6000);
  }
}

function wireText() {
  loadTextPrefs();
  syncTextUi();
  const ta = $('#textBox'), grip = $('#textGrip');
  const refocus = () => { if (S.text) S.text.ta.focus(); };
  const changed = () => { saveTextPrefs(); textRefresh(); };
  ta.addEventListener('input', textRefresh);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); textEnd(false); setMsg(''); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); textEnd(true); }
  });

  // drag the ✥ handle to move the text
  grip.addEventListener('pointerdown', (e) => {
    if (!S.text || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    S.text.drag = { sx: e.clientX, sy: e.clientY, x: S.text.x, y: S.text.y };
  });
  grip.addEventListener('pointermove', (e) => {
    const g = S.text && S.text.drag;
    if (!g) return;
    S.text.x = Math.round(g.x + (e.clientX - g.sx) / S.zoom);
    S.text.y = Math.round(g.y + (e.clientY - g.sy) / S.zoom);
    textRefresh();
  });
  const dropGrip = () => { if (S.text && S.text.drag) { S.text.drag = null; refocus(); } };
  grip.addEventListener('pointerup', dropGrip);
  grip.addEventListener('pointercancel', dropGrip);

  $('#oFont').onclick = () => { if ($('#fontMenu')) closeFontMenu(); else openFontMenu(); };
  // number boxes: size, letter spacing, line height, angle, outline, shadow blur / offset
  for (const [id, key] of [['#oFontSize', 'size'], ['#oSpacing', 'spacing'], ['#oLeading', 'leading'], ['#oAngle', 'rot'], ['#oStroke', 'stroke'],
    ['#oShadowBlur', 'shadowBlur'], ['#oShadowX', 'shadowX'], ['#oShadowY', 'shadowY']]) {
    $(id).oninput = (e) => {
      const v = Math.round(+e.target.value * 100) / 100, [a, b] = TXT_NUM[key];
      if (e.target.value !== '' && Number.isFinite(v) && v >= a && v <= b) { TXT[key] = v; changed(); }
    };
    $(id).onchange = () => syncTextUi();                    // an out-of-range number snaps back to the real value
  }
  // on / off buttons: bold, italic, underline, strikethrough, ALL CAPS, mirror left-right, mirror up-down
  for (const [id, key] of [['#oBold', 'bold'], ['#oItalic', 'italic'], ['#oUnder', 'underline'], ['#oStrike', 'strike'], ['#oCaps', 'caps'], ['#oFlipH', 'flipH'], ['#oFlipV', 'flipV']]) {
    $(id).onclick = () => { TXT[key] = !TXT[key]; syncTextUi(); changed(); refocus(); };
  }
  for (const b of $$('[data-align]')) b.onclick = () => { TXT.align = b.dataset.align; syncTextUi(); changed(); refocus(); };
  $('#oStrokeColor').oninput = (e) => { TXT.strokeColor = e.target.value; changed(); };
  $('#oShadow').onchange = (e) => { TXT.shadow = e.target.checked; changed(); refocus(); };
  $('#oShadowColor').oninput = (e) => { TXT.shadowColor = e.target.value; if (!TXT.shadow) { TXT.shadow = true; syncTextUi(); } changed(); };
  $('#oFontFile').onclick = () => $('#oFontFileIn').click();
  $('#oFontFileIn').onchange = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) loadFontFile(f); };
  $('#oTextEdit').onclick = () => { const d = Paint.doc; if (d) textEditLayer(d.active); };
  $('#oTextApply').onclick = () => { textEnd(true); };
  $('#oTextCancel').onclick = () => { textEnd(false); setMsg(''); };
}

// ---------------------------------------------------------------- tools & options
const TOOL_SHOW = {
  size: ['brush', 'eraser', 'line', 'rect', 'ellipse'],
  hard: ['brush', 'eraser'],
  opac: ['brush', 'eraser', 'fill', 'line', 'rect', 'ellipse', 'text'],
  tol: ['fill'],
  shape: ['line', 'rect', 'ellipse'],
  text: ['text'],
  xform: ['transform'],
};

function setTool(tool) {
  const was = Paint.opts.tool;
  if (tool !== 'text' && !textSettle()) return;              // leaving the Text tool places the text (stays if it cannot be placed)
  if (was === 'transform' && tool !== 'transform') { S.xfDrag = null; Paint.xformEnd(true); } // leaving the Resize tool applies the change
  Paint.opts.tool = tool;
  for (const b of $$('.tool[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  $('#oSize').closest('.opt').hidden = !TOOL_SHOW.size.includes(tool);
  $('#oHard').closest('.opt').hidden = !TOOL_SHOW.hard.includes(tool);
  $('#oOpac').closest('.opt').hidden = !TOOL_SHOW.opac.includes(tool);
  $('#oSym').closest('.opt').hidden = !['brush', 'eraser', 'line', 'rect', 'ellipse'].includes(tool);   // mirror painting only means something for these
  $('[data-for=fill]').hidden = !TOOL_SHOW.tol.includes(tool);
  $('[data-for=shape]').hidden = !TOOL_SHOW.shape.includes(tool);
  $('[data-for=text]').hidden = !TOOL_SHOW.text.includes(tool);
  $('[data-for=xform]').hidden = !TOOL_SHOW.xform.includes(tool);
  $('#viewport').style.cursor = tool === 'move' ? 'move' : tool === 'transform' ? 'default' : tool === 'text' ? 'text' : 'crosshair';
  if (tool === 'text' && was !== 'text') setMsg(t('Text: click on the texture, then type. Ctrl+Enter places it · Esc cancels · drag ✥ to move it'));
  if (tool === 'transform') {
    ensureTransform(was !== tool);
    if (was !== tool) setMsg(t('Resize: drag a corner to scale · Shift = free stretch · Alt = from the centre · drag the round knob to rotate · Enter applies · Esc cancels'));
  }
  syncXformUi();
}

function bindRange(id, valId, apply) {
  const r = $(id), v = $(valId);
  const sync = () => { v.textContent = r.value; apply(+r.value); };
  r.addEventListener('input', sync);
  sync();
}

function wireOptions() {
  bindRange('#oSize', '#oSizeV', (v) => { Paint.opts.size = v; });
  bindRange('#oHard', '#oHardV', (v) => { Paint.opts.hardness = v / 100; });
  bindRange('#oOpac', '#oOpacV', (v) => { Paint.opts.opacity = v / 100; if (S.text) textRefresh(); });
  bindRange('#oTol', '#oTolV', (v) => { Paint.opts.tolerance = v; });
  $('#oFill').onchange = (e) => { Paint.opts.fill = e.target.checked; };
  $('#oSym').onchange = (e) => { Paint.opts.symmetry = e.target.checked; };
  wireText();
  for (const b of $$('.tool[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
  $('#zFit').onclick = fit;
  $('#z100').onclick = () => { const vp = $('#viewport'); zoomAt(1 / S.zoom, vp.getBoundingClientRect().left + vp.clientWidth / 2, vp.getBoundingClientRect().top + vp.clientHeight / 2); };

  // guide
  $('#oGuide').onchange = applyGuideControls;
  $('#oGuideA').oninput = applyGuideControls;
}

function applyGuideControls() {
  const d = Paint.doc;
  if (!d || !d.guide) return;
  d.guide.visible = $('#oGuide').checked;
  d.guide.opacity = +$('#oGuideA').value / 100;
  Paint.render();
}
function syncGuideControls() {
  const d = Paint.doc;
  if (d && d.guide) { $('#oGuide').checked = d.guide.visible; $('#oGuideA').value = Math.round(d.guide.opacity * 100); }
}

// ---------------------------------------------------------------- color
const PALETTE = ['#000000', '#ffffff', '#e03131', '#f08c00', '#fcc419', '#2f9e44', '#1971c2', '#7048e8', '#c2255c', '#868e96'];
let prevColor = '#ffffff';
const WHEEL = 172; // CSS pixels

/** h 0-360, s and v 0-1 -> [r, g, b] 0-255 */
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
const hsvHex = (h, s, v) => Paint.util.rgbHex(...hsvToRgb(h, s, v));

/** Keeps the previous hue for greys/blacks, where the hue is undefined (otherwise the wheel would jump to red). */
function rgbToHsv(r, g, b, prev) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = prev.h;
  if (d > 1e-6) {
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}

function setColor(hex, remember = true, from = null) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
  hex = hex.toLowerCase();
  if (remember && hex !== Paint.opts.color) prevColor = Paint.opts.color;
  Paint.opts.color = hex;
  if (from !== 'hsv') S.hsv = rgbToHsv(...Paint.util.hexRgb(hex), S.hsv);   // wheel/sliders own the hsv value while you drag them
  syncColorUi();
  if (S.text) textRefresh();
}

function wheelGeom(c) {
  const n = c.width, cx = n / 2, R = n / 2 - 2, ring = n * 0.115, r0 = R - ring;
  const half = (r0 - n * 0.03) / Math.SQRT2;
  return { n, cx, R, ring, r0, half, x0: cx - half, y0: cx - half, side: half * 2 };
}

function drawWheel() {
  const c = $('#wheel'), dpr = window.devicePixelRatio || 1, px = Math.round(WHEEL * dpr);
  if (c.width !== px) { c.width = px; c.height = px; }
  const g = c.getContext('2d'), gm = wheelGeom(c), { h, s, v } = S.hsv, u = dpr;
  g.clearRect(0, 0, c.width, c.height);

  // hue ring
  const cg = g.createConicGradient(-Math.PI / 2, gm.cx, gm.cx);
  for (let i = 0; i <= 6; i++) cg.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
  g.fillStyle = cg;
  g.beginPath(); g.arc(gm.cx, gm.cx, gm.R, 0, Math.PI * 2); g.arc(gm.cx, gm.cx, gm.r0, 0, Math.PI * 2, true); g.fill();

  // saturation (left -> right) and brightness (bottom -> top) square for the current hue
  g.fillStyle = `hsl(${h},100%,50%)`; g.fillRect(gm.x0, gm.y0, gm.side, gm.side);
  const wg = g.createLinearGradient(gm.x0, 0, gm.x0 + gm.side, 0);
  wg.addColorStop(0, '#fff'); wg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = wg; g.fillRect(gm.x0, gm.y0, gm.side, gm.side);
  const bg = g.createLinearGradient(0, gm.y0, 0, gm.y0 + gm.side);
  bg.addColorStop(0, 'rgba(0,0,0,0)'); bg.addColorStop(1, '#000');
  g.fillStyle = bg; g.fillRect(gm.x0, gm.y0, gm.side, gm.side);

  const marker = (x, y, r, fill) => {
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = fill; g.fill();
    g.lineWidth = 2.5 * u; g.strokeStyle = '#000b'; g.stroke();
    g.lineWidth = 1.5 * u; g.strokeStyle = '#fff'; g.stroke();
  };
  const a = ((h - 90) * Math.PI) / 180, rm = (gm.R + gm.r0) / 2;
  marker(gm.cx + Math.cos(a) * rm, gm.cx + Math.sin(a) * rm, gm.ring * 0.36, `hsl(${h},100%,50%)`);
  marker(gm.x0 + s * gm.side, gm.y0 + (1 - v) * gm.side, 6.5 * u, Paint.opts.color);
}

/** Remember the colour from before a drag so Swap / X goes back to it, not to a half-way value. */
let colorAnchor = null;
const beginColorEdit = () => { if (colorAnchor === null) colorAnchor = Paint.opts.color; };
function endColorEdit() {
  if (colorAnchor !== null && colorAnchor !== Paint.opts.color) prevColor = colorAnchor;
  colorAnchor = null;
  syncColorUi();
}

function syncColorUi() {
  const hex = Paint.opts.color, { h, s, v } = S.hsv, [r, g, b] = Paint.util.hexRgb(hex);
  const put = (id, val) => { const i = $(id); if (document.activeElement !== i) i.value = val; };
  put('#cHex', hex);
  put('#cR', r); put('#cG', g); put('#cB', b);
  $('#cNow').style.background = hex; $('#cPrev').style.background = prevColor;
  $('#cH').value = Math.round(h); $('#cS').value = Math.round(s * 100); $('#cV').value = Math.round(v * 100);
  $('#cHV').textContent = Math.round(h) + '°'; $('#cSV').textContent = Math.round(s * 100); $('#cVV').textContent = Math.round(v * 100);
  $('#cS').style.setProperty('--g', `linear-gradient(90deg, ${hsvHex(h, 0, v)}, ${hsvHex(h, 1, v)})`);
  $('#cV').style.setProperty('--g', `linear-gradient(90deg, #000, ${hsvHex(h, s, 1)})`);
  drawWheel();
}

function pushHsv() { setColor(hsvHex(S.hsv.h, S.hsv.s, S.hsv.v), false, 'hsv'); }

function wireWheel() {
  const c = $('#wheel');
  let mode = null;
  const where = (e) => {
    const r = c.getBoundingClientRect(), k = c.width / r.width, gm = wheelGeom(c);
    return { gm, x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  };
  const apply = (e) => {
    const { gm, x, y } = where(e);
    if (mode === 'hue') S.hsv.h = (Math.atan2(y - gm.cx, x - gm.cx) * 180 / Math.PI + 90 + 360) % 360;
    else { S.hsv.s = clamp((x - gm.x0) / gm.side, 0, 1); S.hsv.v = 1 - clamp((y - gm.y0) / gm.side, 0, 1); }
    pushHsv();
  };
  c.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const { gm, x, y } = where(e), dist = Math.hypot(x - gm.cx, y - gm.cx);
    if (dist > gm.R + 6) return;
    mode = dist >= gm.r0 - gm.n * 0.015 ? 'hue' : 'sv';
    c.setPointerCapture(e.pointerId);
    beginColorEdit();
    apply(e);
  });
  c.addEventListener('pointermove', (e) => { if (mode) apply(e); });
  const end = () => { if (!mode) return; mode = null; endColorEdit(); };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}

function pushRecent(hex) {
  if (S.recent[0] === hex) return;
  S.recent = [hex, ...S.recent.filter((c) => c !== hex)].slice(0, 20);
  renderSwatches();
}

function renderSwatches() {
  const box = $('#swatches');
  box.textContent = '';
  for (const c of [...PALETTE, ...S.recent]) {
    const s = el('div', 'sw');
    s.style.background = c; s.title = c;
    s.onclick = () => setColor(c);
    box.append(s);
  }
}

function wireColor() {
  $('#cHex').onchange = (e) => {
    let v = e.target.value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(v)) v = v.split('').map((ch) => ch + ch).join('');   // #f80 -> #ff8800
    setColor('#' + v);
    e.target.value = Paint.opts.color;
  };
  $('#cPrev').onclick = () => setColor(prevColor);

  for (const [id, key, max] of [['#cH', 'h', 1], ['#cS', 's', 100], ['#cV', 'v', 100]]) {
    const r = $(id);
    r.addEventListener('input', () => { beginColorEdit(); S.hsv[key] = +r.value / max; pushHsv(); });
    r.addEventListener('change', endColorEdit);
  }
  const fromRgb = () => {
    const [r, g, b] = ['#cR', '#cG', '#cB'].map((id) => parseInt($(id).value, 10));
    if ([r, g, b].every((n) => n >= 0 && n <= 255)) setColor(Paint.util.rgbHex(r, g, b));
  };
  for (const id of ['#cR', '#cG', '#cB']) $(id).addEventListener('input', fromRgb);

  if (window.EyeDropper) {
    $('#cScreen').onclick = async () => {
      try { setColor((await new window.EyeDropper().open()).sRGBHex); } catch { /* cancelled */ }
    };
  } else $('#cScreen').hidden = true;

  wireWheel();
  renderSwatches();
  setColor(Paint.opts.color, false);
}

// ---------------------------------------------------------------- layer buttons
function wireLayerPanel() {
  // every layer button first places the text you are still typing, then does its job; the click is not left "pressed" (Space would repeat it)
  const act = (fn) => (e) => { if (e && e.currentTarget) e.currentTarget.blur(); if (Paint.doc && textSettle()) fn(Paint.doc); };
  $('#lAdd').onclick = act(() => Paint.layerOp.add());
  $('#lDup').onclick = act(() => Paint.layerOp.duplicate());
  $('#lUp').onclick = act(() => Paint.layerOp.move(1));
  $('#lDown').onclick = act(() => Paint.layerOp.move(-1));
  $('#lLock').onclick = act((d) => Paint.layerOp.set(d.active, 'locked', !d.layers[d.active].locked));
  $('#lMerge').onclick = act(() => Paint.layerOp.mergeDown());
  $('#lRename').onclick = act((d) => renameLayer(d.active));
  $('#lDel').onclick = act(() => Paint.layerOp.remove());
  S.layerKeys = { j: () => Paint.layerOp.duplicate(), e: () => Paint.layerOp.mergeDown(), ']': () => Paint.layerOp.move(1), '[': () => Paint.layerOp.move(-1) };
  const blend = $('#lBlend');
  for (const b of Paint.BLENDS) {
    if (!b) { const o = el('option', 'divider', '──────────'); o.disabled = true; blend.append(o); continue; }   // the groups of Photoshop's list
    const o = el('option', '', t(b[1])); o.value = b[0]; blend.append(o);
  }
  blend.onchange = () => Paint.doc && Paint.layerOp.set(Paint.doc.active, 'blend', blend.value);
  $('#lClip').onclick = act((d) => { if (d.active > 0) Paint.layerOp.set(d.active, 'clip', !d.layers[d.active].clip); });
  $('#lFabric').onclick = act(() => fabricLook());
  $('#lOpacity').oninput = (e) => {
    if (!Paint.doc) return;
    $('#lOpacityV').textContent = e.target.value;
    Paint.doc.layers[Paint.doc.active].opacity = +e.target.value / 100;
    Paint.render(); onChange({ final: false });
  };
  $('#lImport').onclick = () => importImage('layer');
  $('#lGuideImport').onclick = () => importImage('guide');
}

// ---------------------------------------------------------------- Fabric look
// A print pasted on a shirt looks flat because the cloth's folds and weave stop at its edge. Fabric look puts them back on top
// of it as ordinary layers (change their Opacity / Blend later, or delete them): the folds and creases of the bottom layer (the
// texture as it came from the .ytd) and a fabric grain, both grey maps blended with Hard light (grey 128 changes nothing) and
// clipped to the print. It can also bend the print along the folds and change its blend mode (the "ink"). Everything shows
// live while the dialog is open (Paint.setPreview) and goes into the document as one undo step.
const GRAIN_LABELS = {
  cotton: N_('Cotton (plain weave)'), jersey: N_('Jersey knit (T-shirt)'), denim: N_('Denim (twill)'), canvas: N_('Canvas'),
  mesh: N_('Sports mesh'), fleece: N_('Fleece'), leather: N_('Leather'), noise: N_('Fine grain'),
};
const GRAIN_SIZE = { cotton: 3, jersey: 3, denim: 4, canvas: 3, mesh: 4, fleece: 4, leather: 4, noise: 3 };
const FABRIC_BLENDS = [
  ['hard-light', N_('Hard light: shading on every colour')],
  ['overlay', N_('Overlay: strongest on mid tones')],
  ['soft-light', N_('Soft light: gentle')],
];
const INKS = [
  ['', N_('Leave it as it is')],
  ['multiply', N_('Multiply: the cloth shows through the ink')],
  ['source-over', N_('Normal: solid ink')],
];
/** The dialog's settings, kept until the app closes. foldSize 0: chosen from the texture's size the first time. */
const FAB = { folds: true, foldStrength: 70, foldSize: 0, grain: true, grainKind: 'cotton', grainStrength: 30, grainSize: 3, look: 'hard-light', bend: false, bendAmount: 6, ink: '', onlyPrint: true };

async function fabricLook() {
  const d = Paint.doc;
  if (!d || !S.sel) { toast(t('Pick a piece first.'), 'warn'); return; }
  if (!textSettle()) return;
  if (Paint.xf) Paint.xformEnd(true);                  // a resize that is still open is applied first
  const w = d.w, h = d.h, ai = d.active;
  let print = ai;                                      // the print: the selected layer, or the one a selected clipped layer belongs to
  while (print > 0 && d.layers[print].clip) print--;
  const P = d.layers[print], hasPrint = print > 0, canBend = hasPrint && !P.locked, oldInk = P.blend;
  if (!FAB.foldSize) FAB.foldSize = clamp(Math.round(Math.max(w, h) / 128), 2, 32);

  // the maps, each made once per setting while the dialog is open
  const cache = new Map();
  const cached = (key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };
  let base = null, printPx = null;
  const folds = (size) => cached('f' + size, () => foldsMap(base || (base = Paint.layerRGBA(0)), w, h, { size }).rgba);
  const grain = (kind, size) => cached(`g${kind}|${size}`, () => grainMap(kind, w, h, { size }).rgba);
  const bent = (size, amount) => cached(`b${size}|${amount}`, () => bend(printPx || (printPx = Paint.layerRGBA(print)), w, h, folds(size), amount));

  const foldLayer = Paint.makeLayer(null, { name: t('Fabric folds') }), grainLayer = Paint.makeLayer(null, {});
  const bentCanvas = Paint.makeLayer(null, {}).canvas;
  const put = (canvas, rgba) => canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  const shown = { fold: '', grain: '', bent: '' };
  const plan = () => {                                 // what Add does with the settings as they are now
    const only = hasPrint && FAB.onlyPrint;
    return {
      only, after: only ? ai : d.layers.length - 1,
      layers: [FAB.grain && grainLayer, FAB.folds && foldLayer].filter(Boolean),
      bend: canBend && only && FAB.bend && FAB.bendAmount > 0,
      ink: hasPrint && FAB.ink && FAB.ink !== oldInk ? FAB.ink : null,
    };
  };
  let sync = () => {};
  function refresh() {
    const p = plan();
    if (FAB.folds && shown.fold !== String(FAB.foldSize)) { put(foldLayer.canvas, folds(FAB.foldSize)); shown.fold = String(FAB.foldSize); }
    const gk = FAB.grainKind + '|' + FAB.grainSize;
    if (FAB.grain && shown.grain !== gk) { put(grainLayer.canvas, grain(FAB.grainKind, FAB.grainSize)); shown.grain = gk; }
    foldLayer.opacity = FAB.foldStrength / 100; grainLayer.opacity = FAB.grainStrength / 100;
    foldLayer.blend = grainLayer.blend = FAB.look; foldLayer.clip = grainLayer.clip = p.only;
    grainLayer.name = t('Fabric grain: {kind}', { kind: t(GRAIN_LABELS[FAB.grainKind]) });
    let replace = null;
    if (p.bend) {
      const bk = FAB.foldSize + '|' + FAB.bendAmount;
      if (shown.bent !== bk) { put(bentCanvas, bent(FAB.foldSize, FAB.bendAmount)); shown.bent = bk; }
      replace = { i: print, canvas: bentCanvas };
    }
    P.blend = p.ink || oldInk;                          // the ink shows live; the old one is back before the real change, so Undo has it
    Paint.setPreview({ after: p.after, layers: p.layers, replace });
    onChange({ final: false });
    setMsg('');
    sync();
  }
  let queued = false;
  const update = () => { if (queued) return; queued = true; setTimeout(() => { queued = false; refresh(); }, 16); };

  // ---- the dialog
  const box = el('div', 'fab');
  box.append(el('p', '', hasPrint
    ? t('Makes "{name}" look printed on the cloth: the folds and the weave of the fabric show on it. They are added as layers you can change or delete later.', { name: P.name })
    : t('Adds the folds and the weave of the fabric over the whole texture. To put them on a print only, select the print\'s layer first.')));
  const row = (label, input, value) => { const r = el('div', 'fab-row'); r.append(el('label', '', label), input); if (value) r.append(value); return r; };
  const slider = (label, min, max, key, unit, heavy) => {
    const inp = el('input'), val = el('span', 'val');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = 1; inp.value = FAB[key];
    const show = () => { val.textContent = inp.value + unit; };
    show();
    inp.addEventListener('input', () => { show(); if (!heavy) { FAB[key] = +inp.value; update(); } });
    inp.addEventListener('change', () => { FAB[key] = +inp.value; update(); });     // a new map is made when the slider is let go
    return { r: row(label, inp, val), inp, show };
  };
  const choice = (label, options, key, then) => {
    const s = el('select');
    for (const [v, label] of options) { const o = el('option', '', t(label)); o.value = v; s.append(o); }
    s.value = FAB[key];
    s.onchange = () => { FAB[key] = s.value; if (then) then(); update(); };
    return row(label, s);
  };
  const section = (label, key, note) => {
    const lab = el('label', 'fab-check'), cb = el('input'), part = el('div', 'fab-part');
    cb.type = 'checkbox'; cb.checked = !!FAB[key];
    cb.onchange = () => { FAB[key] = cb.checked; update(); };
    lab.append(cb, document.createTextNode(' ' + label));
    if (note) part.append(el('div', 'fab-note', note));
    box.append(lab, part);
    return { cb, part };
  };

  const fSec = section(t('Folds and creases'), 'folds', t('Taken from "{name}", the texture under your painting.', { name: d.layers[0].name }));
  fSec.part.append(slider(t('Strength'), 0, 100, 'foldStrength', ' %').r, slider(t('Fold size'), 1, 48, 'foldSize', ' px', true).r);
  const gSec = section(t('Fabric grain'), 'grain');
  const gSize = slider(t('Grain size'), 1, 16, 'grainSize', ' px', true);
  gSec.part.append(
    choice(t('Fabric'), GRAINS.map((k) => [k, GRAIN_LABELS[k]]), 'grainKind', () => { FAB.grainSize = GRAIN_SIZE[FAB.grainKind]; gSize.inp.value = FAB.grainSize; gSize.show(); }),
    slider(t('Strength'), 0, 100, 'grainStrength', ' %').r, gSize.r);
  box.append(choice(t('Blend'), FABRIC_BLENDS, 'look'));
  const bSec = section(t('Bend the print with the folds'), 'bend', !hasPrint ? t('Select the layer with your print to bend it.')
    : P.locked ? t('"{name}" is locked. Unlock it to bend it.', { name: P.name })
      : P.text ? t('"{name}" is live text: bending turns it into plain pixels (Undo brings the text back).', { name: P.name })
        : t('Moves the pixels of "{name}" along the creases, like Photoshop\'s Displace filter. Best done last, after the print is in place.', { name: P.name }));
  bSec.part.append(slider(t('Amount'), 1, 30, 'bendAmount', ' px', true).r);
  if (hasPrint) {
    box.append(choice(t('Ink'), INKS, 'ink'));
    const where = el('div', 'fab-apply');
    for (const [only, text] of [[true, t('Only on "{name}" (clipped to it)', { name: P.name })], [false, t('On the whole texture')]]) {
      const lab = el('label'), r = el('input');
      r.type = 'radio'; r.name = 'fabWhere'; r.checked = FAB.onlyPrint === only;
      r.onchange = () => { FAB.onlyPrint = only; update(); };
      lab.append(r, document.createTextNode(' ' + text));
      where.append(lab);
    }
    box.append(row(t('Apply to'), where));
  }
  sync = () => {                                      // grey out what is switched off; Bend needs a print of its own
    const bendable = canBend && FAB.onlyPrint;
    fSec.part.classList.toggle('off', !FAB.folds);
    gSec.part.classList.toggle('off', !FAB.grain);
    bSec.cb.disabled = !bendable; bSec.cb.checked = bendable && FAB.bend;
    bSec.part.classList.toggle('off', !(bendable && FAB.bend));
  };

  const answer = modal({ title: t('Fabric look'), content: box, side: true, buttons: [{ id: 'cancel', label: t('Cancel') }, { id: 'ok', label: t('Add'), accent: true }] });
  setMsg(t('Making the fabric maps…'));
  update();
  const r = await answer;
  if (r === 'ok') refresh();                           // a slider let go just before OK is in too
  P.blend = oldInk;
  const p = plan();
  if (r !== 'ok' || (!p.layers.length && !p.bend && !p.ink)) { Paint.setPreview(null); onChange({ final: true }); setMsg(''); return; }
  Paint.insertLayers({
    after: p.after, layers: p.layers,
    replace: p.bend ? { i: print, rgba: bent(FAB.foldSize, FAB.bendAmount) } : null,
    blend: p.ink ? { i: print, mode: p.ink } : null,
  });
  toast(t('Fabric look added. Fine-tune it with the Opacity and Blend of its layers, or delete them.'), 'ok', 7000);
}

// ---------------------------------------------------------------- import / export / save
/**
 * "This is bigger than the texture": keep the texture's size (what comes in is scaled down), or make the texture bigger.
 * { intro, keepNote, growNote }: the three sentences that differ between an image and a saved project; d: the open document;
 * sizes: what growSizes offers. Answers null (Cancel), 'keep' or { w, h }.
 */
async function askBigger({ intro, keepNote, growNote }, d, sizes) {
  const fmt = (S.sel && S.sel.tex.format) || 'DXT1', cur = `${d.w}×${d.h}`;
  const check = { label: t('Always keep the texture size, do not ask again (until the app is restarted)'), value: false };
  const r = await modal({
    title: t('Bigger than the texture'),
    lines: [
      intro,
      sentences(keepNote, growNote),
      memoryLine(d.w, d.h, fmt, sizes),
    ],
    check,
    buttons: [{ id: 'cancel', label: t('Cancel') }, { id: 'keep', label: t('Keep {size}', { size: cur }), accent: true },
      ...sizes.map((s) => ({ id: `s${s.w}x${s.h}`, label: t('Resize to {size}', { size: `${s.w}×${s.h}` }) }))],
  });
  if (!r) return null;
  if (r === 'keep') { if (check.value) S.keepSize = true; return 'keep'; }
  const m = /^s(\d+)x(\d+)$/.exec(r);
  return { w: +m[1], h: +m[2] };
}

async function importFromDataUrl(url, mode, name) {
  if (!Paint.doc) { toast(t('Pick a piece first.'), 'warn'); return; }
  const img = await Paint.loadImage(url);
  if (mode === 'guide') { Paint.setGuide(img); applyGuideControls(); }
  else {
    let native = false;
    const d = Paint.doc, iw = img.naturalWidth, ih = img.naturalHeight;
    const sizes = S.sel && !S.keepSize ? growSizes(d.w, d.h, iw, ih) : [];
    if (sizes.length) {                                              // bigger than the texture: keep its size, or make the texture bigger (like Paint.NET's canvas question)
      const cur = `${d.w}×${d.h}`;
      const pick = await askBigger({
        intro: name ? t('"{name}" is {size}, bigger than this texture ({cur}).', { name, size: `${iw}×${ih}`, cur }) : t('This image is {size}, bigger than this texture ({cur}).', { size: `${iw}×${ih}`, cur }),
        keepNote: t('Keep {cur} and the image is scaled down to fit.', { cur }),
        growNote: t('Or make the texture bigger so the image keeps its detail: what you have painted is scaled up with it, Undo brings the old size back, and the .ytd only changes when you press Save to YTD.'),
      }, d, sizes);
      if (!pick) return;                                             // Cancel: nothing is imported
      if (pick !== 'keep') { if (!resizeTextureTo(pick.w, pick.h)) return; native = true; }
    }
    Paint.addImageLayer(img, { name: name || t('Image'), fit: 'contain', maxFraction: 0.6, native });      // native: after a resize the image goes in at its own pixels
    setTool('transform');   // straight into resize mode so the new image can be sized and placed
  }
}

async function importImage(mode) {
  try {
    const url = await api.openImage();
    if (url) await importFromDataUrl(url, mode);
  } catch (e) { toast(String(e.message || e), 'error'); }
}

async function saveToYtd() {
  const e = S.sel;
  if (!e) { toast(t('Pick a piece first.'), 'warn'); return; }
  if (!textSettle()) return;                          // text you are still typing is part of the painting
  const name = basename(e.ytd);
  const rgba = Paint.flatRGBA(e.doc);                 // this piece's pixels, taken now: whatever is selected while the dialog is open
  const w = e.doc.w, h = e.doc.h, resizing = w !== e.tex.width || h !== e.tex.height;       // the painting was given a new size: the .ytd is rewritten at that size
  const ok = await confirmBox(t('Write painting into the YTD'), resizing ? [
    t('This overwrites {name}', { name }),
    t('The texture changes size: {from} → {to} {fmt}. Its mip levels are regenerated.', { from: `${e.tex.width}×${e.tex.height}`, to: `${w}×${h}`, fmt: e.tex.format }),
    t('In game it then takes about {to} instead of {from}.', { to: mbText(memoryMB(w, h, e.tex.format)), from: mbText(memoryMB(e.tex.width, e.tex.height, e.tex.format)) }),
    t('The first time, the untouched original ({size}) is kept as {name}.bak next to it.', { size: `${e.tex.width}×${e.tex.height}`, name }),
  ] : [
    t('This overwrites {name}', { name }),
    e.tex.mips > 1 ? t('{size} {fmt}, {mips} mips are regenerated.', { size: `${e.tex.width}×${e.tex.height}`, fmt: e.tex.format, mips: e.tex.mips }) : `${e.tex.width}×${e.tex.height} ${e.tex.format}.`,
    t('The first time, the untouched original is kept as {name}.bak next to it.', { name }),
  ], t('Write to YTD'));
  if (!ok) return;
  try {
    setMsg(t('Encoding…'));
    const res = await api.saveTexture(e.ytd, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), resizing ? { width: w, height: h } : undefined);
    e.doc.dirty = false;
    if (resizing) { e.tex.width = w; e.tex.height = h; e.tex.mips = res.mips || e.tex.mips; showTexSize(e); }       // the file really has that size now
    renderTree();
    toast(res.backup ? t('Saved {name} (backup: {backup}). Restart or refresh the resource on your server to see it.', { name, backup: basename(res.backup) }) : t('Saved {name}. Restart or refresh the resource on your server to see it.', { name }), 'ok', 8000);
  } catch (err) {
    toast(t('Save failed: {error}', { error: err.message || err }), 'error', 10000);
  } finally { setMsg(''); }
}

async function exportPng() {
  if (!Paint.doc || !S.sel) { toast(t('Pick a piece first.'), 'warn'); return; }
  if (!textSettle()) return;
  try {
    const where = await api.savePng(`${basename(S.sel.ytd).replace(/\.ytd$/i, '').replace(/\^/g, '__')}.png`, Paint.flat(1).toDataURL('image/png'));
    if (where) toast(t('Exported {where}', { where }), 'ok');
  } catch (e) { toast(String(e.message || e), 'error'); }
}

async function saveProject() {
  if (!Paint.doc || !S.sel) { toast(t('Pick a piece first.'), 'warn'); return; }
  if (!textSettle()) return;
  try {
    const data = { app: 'ClothingStudio', ytd: basename(S.sel.ytd), doc: Paint.serialize() };
    const where = await api.saveProject(`${basename(S.sel.ytd).replace(/\.ytd$/i, '').replace(/\^/g, '__')}.csproj`, JSON.stringify(data));
    if (where) toast(t('Saved layers to {where}', { where }), 'ok');
  } catch (e) { toast(String(e.message || e), 'error'); }
}

async function openProject() {
  if (!S.sel) { toast(t('Pick a piece first.'), 'warn'); return; }
  if (!textSettle()) return;
  try {
    const text = await api.openProject();
    if (!text) return;
    const data = JSON.parse(text);
    if (data.app !== 'ClothingStudio' || !data.doc) throw new Error(t('That is not a ClothingStudio project.'));
    if (data.ytd !== basename(S.sel.ytd) &&
        !(await confirmBox(t('Different texture'), [t('This project was saved for {saved}, but you are editing {current}.', { saved: data.ytd, current: basename(S.sel.ytd) }), t('Load it anyway? Layers are scaled to fit.')], t('Load anyway')))) return;
    const was = S.sel.doc;
    let w = was.w, h = was.h;
    const sizes = S.keepSize ? [] : growSizes(w, h, Number(data.doc.w), Number(data.doc.h));
    if (sizes.length) {                                              // saved at a bigger resolution than the texture has now: do not shrink it without asking
      const pick = await askBigger({
        intro: t('These layers were saved at {saved}, bigger than this texture ({cur}).', { saved: `${data.doc.w}×${data.doc.h}`, cur: `${w}×${h}` }),
        keepNote: t('Keep {cur} and the layers are scaled down (live text becomes plain pixels).', { cur: `${w}×${h}` }),
        growNote: t('Or make the texture bigger: the layers load as they were saved, live text included. The .ytd only changes when you press Save to YTD.'),
      }, was, sizes);
      if (!pick) return;
      if (pick !== 'keep') { w = pick.w; h = pick.h; }
    }
    const doc = await Paint.deserialize(data.doc, w, h);
    doc.dirty = true;
    doc.guide = was.guide;
    S.sel.doc = doc;
    Paint.setDoc(doc);
    if (w !== was.w || h !== was.h) onDocResized();                  // UV lines, 3D copy, status text and zoom for the new size
    Paint.flatInto(S.sel.preview); viewer.refresh(); queuePopTex();
    renderTree(); fit();
    toast(t('Layers loaded.'), 'ok');
  } catch (e) { toast(String(e.message || e), 'error', 8000); }
}

// ---------------------------------------------------------------- drag & drop, paste
function wireDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; $('#dropHint').hidden = false; });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('#dropHint').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); depth = 0; $('#dropHint').hidden = true;
    if (dialogOpen()) { toast(t('Finish or close the open dialog first (it has its own "Add more .ydd…" button).'), 'warn', 4000); return; }
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const ydds = [...e.dataTransfer.files].filter((x) => /\.ydd$/i.test(x.name));
    if (ydds.length) {                                               // dropped models: open the Add pieces dialog
      try { addPiecesFlow(await api.registerYdd(ydds.map((x) => api.pathForFile(x)).filter(Boolean))); } catch (err) { toast(String(err.message || err), 'error', 8000); }
      return;
    }
    try {
      if (f.type.startsWith('image/')) {
        await importFromDataUrl(URL.createObjectURL(f), 'layer', f.name.replace(/\.[^.]+$/, ''));
        return;
      }
      const p = api.pathForFile(f);
      if (!p) { toast(t('Folder drop needs the desktop app. Use ?pack= in the dev page.'), 'warn'); return; }
      await loadPack(await api.scanPack(p));
    } catch (err) { toast(String(err.message || err), 'error', 8000); }
  });
  window.addEventListener('paste', async (e) => {
    if (/input|textarea/i.test(document.activeElement && document.activeElement.tagName)) return;
    if (dialogOpen()) return;
    for (const it of e.clipboardData.items) {
      if (it.type.startsWith('image/')) {
        await importFromDataUrl(URL.createObjectURL(it.getAsFile()), 'layer', t('Pasted'));
        return;
      }
    }
  });
}

// ---------------------------------------------------------------- keyboard
// Every shortcut is in this table: its keys (spelled as keys.js spells a key press), its group and text in the list of shortcuts (F1),
// and what it does. KEY_HINTS adds what the list also explains but that is not a single key press (Alt+click, Space+drag ...).
const KEY_NAME = { Ctrl: N_('Ctrl'), Shift: N_('Shift'), Alt: N_('Alt'), Space: N_('Space'), Delete: N_('Del'), Escape: N_('Esc'), Enter: N_('Enter'), PageDown: N_('Page Down'), PageUp: N_('Page Up') };
const keyName = (k) => (KEY_NAME[k] ? t(KEY_NAME[k]) : k);
const clickBtn = (id) => () => { const b = $(id); if (b && !b.disabled) b.click(); };
const stepRange = (id, to) => { const r = $(id); r.value = clamp(Math.round(to(+r.value)), +r.min, +r.max); r.dispatchEvent(new Event('input')); };
const toggleBox = (id) => { const c = $(id); c.checked = !c.checked; c.dispatchEvent(new Event('change')); };
const zoomCenter = (f) => { const vp = $('#viewport'), r = vp.getBoundingClientRect(); zoomAt(f, r.left + vp.clientWidth / 2, r.top + vp.clientHeight / 2); };
const onDoc = (fn) => () => { if (Paint.doc && S.sel && textSettle()) fn(Paint.doc); };
const G = { files: N_('Files'), pieces: N_('Pieces and textures'), edit: N_('Edit'), tools: N_('Tools'), paint: N_('Painting'), layers: N_('Layers'), view: N_('View'), modes: N_('Text and Resize tools'), help: N_('Help') };

const SHORTCUTS = [
  { group: G.files, keys: ['Ctrl+O'], text: N_('Open pack…'), run: () => openPackDialog() },
  { group: G.files, keys: ['Ctrl+S'], text: N_('Save to YTD'), run: () => saveToYtd() },
  { group: G.files, keys: ['Ctrl+Shift+S'], text: N_('Save layers…'), run: () => saveProject() },
  { group: G.files, keys: ['Ctrl+Shift+O'], text: N_('Open layers…'), run: () => openProject() },
  { group: G.files, keys: ['Ctrl+Shift+E'], text: N_('Export PNG'), run: () => exportPng() },
  { group: G.files, keys: ['Ctrl+I'], text: N_('Import image…'), run: () => importImage('layer') },
  { group: G.files, keys: ['Ctrl+B'], text: N_('Build the pack (FiveM or single player)…'), run: () => buildPackUi() },

  { group: G.pieces, keys: ['PageDown'], text: N_('Next texture (then the next piece)'), run: () => stepTexture(1) },
  { group: G.pieces, keys: ['PageUp'], text: N_('Previous texture'), run: () => stepTexture(-1) },
  { group: G.pieces, keys: ['Ctrl+PageDown'], text: N_('Next piece'), run: () => stepPiece(1) },
  { group: G.pieces, keys: ['Ctrl+PageUp'], text: N_('Previous piece'), run: () => stepPiece(-1) },
  { group: G.pieces, keys: ['Ctrl+D'], text: N_('Copy this texture to other pieces…'), run: () => { if (S.sel) copyTextureUi(S.sel.item, S.sel.variant); } },
  { group: G.pieces, keys: ['Ctrl+Shift+D'], text: N_('New texture for this piece, a copy of this one'), run: () => { if (S.sel) addVariant(S.sel.item); } },
  { group: G.pieces, keys: ['Ctrl+P'], text: N_('Piece options'), run: () => { if (S.sel) openOptions(S.sel.item); } },

  { group: G.edit, keys: ['Ctrl+Z'], text: N_('Undo'), run: () => { if (S.text) textEnd(false); else if (Paint.doc) Paint.undo(); } },
  { group: G.edit, keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], text: N_('Redo'), run: () => { if (S.text) textEnd(false); else if (Paint.doc) Paint.redo(); } },

  { group: G.tools, keys: ['B'], text: N_('Brush'), run: () => setTool('brush') },
  { group: G.tools, keys: ['E'], text: N_('Erase'), run: () => setTool('eraser') },
  { group: G.tools, keys: ['G'], text: N_('Fill'), run: () => setTool('fill') },
  { group: G.tools, keys: ['I'], text: N_('Pick'), run: () => setTool('eyedrop') },
  { group: G.tools, keys: ['L'], text: N_('Line'), run: () => setTool('line') },
  { group: G.tools, keys: ['R'], text: N_('Rect'), run: () => setTool('rect') },
  { group: G.tools, keys: ['O'], text: N_('Oval'), run: () => setTool('ellipse') },
  { group: G.tools, keys: ['T'], text: N_('Text'), run: () => setTool('text') },
  { group: G.tools, keys: ['V'], text: N_('Move'), run: () => setTool('move') },
  { group: G.tools, keys: ['S', 'Ctrl+T'], text: N_('Resize'), run: () => setTool('transform') },

  { group: G.paint, keys: ['[', ']'], show: [['['], [']']], text: N_('Smaller / bigger brush'), run: (e, k) => stepRange('#oSize', (v) => (k === ']' ? v + Math.max(1, v * 0.15) : v - Math.max(1, v * 0.15))) },
  { group: G.paint, keys: ['Shift+[', 'Shift+]'], show: [['Shift', '['], ['Shift', ']']], text: N_('Softer / harder brush'), run: (e, k) => stepRange('#oHard', (v) => v + (k === 'Shift+]' ? 10 : -10)) },
  { group: G.paint, keys: [], match: (e) => digitOf(e) !== null && !e.shiftKey, show: [['1'], ['9']], showSep: '…', text: N_('Opacity 10 % … 90 %, 0 = 100 %'), run: (e) => stepRange('#oOpac', () => digitOf(e) * 10) },
  { group: G.paint, keys: ['X'], text: N_('Swap with the previous colour'), run: () => setColor(prevColor) },
  { group: G.paint, keys: ['D'], text: N_('Black, with white as the previous colour'), run: () => { setColor('#000000', false); prevColor = '#ffffff'; syncColorUi(); } },
  { group: G.paint, keys: ['M'], text: N_('Mirror painting on / off'), run: () => toggleBox('#oSym') },

  { group: G.layers, keys: ['Ctrl+Shift+N'], text: N_('New layer'), run: clickBtn('#lAdd') },
  { group: G.layers, keys: ['Ctrl+J'], text: N_('Duplicate the layer'), run: clickBtn('#lDup') },
  { group: G.layers, keys: ['Ctrl+E'], text: N_('Merge down'), run: clickBtn('#lMerge') },
  { group: G.layers, keys: ['Ctrl+]', 'Ctrl+['], show: [['Ctrl', ']'], ['Ctrl', '[']], text: N_('Move the layer up / down'), run: (e, k) => clickBtn(k === 'Ctrl+]' ? '#lUp' : '#lDown')() },
  { group: G.layers, keys: ['Alt+]', 'Alt+['], show: [['Alt', ']'], ['Alt', '[']], text: N_('Select the layer above / below'), run: (e, k) => onDoc((d) => Paint.layerOp.select(clamp(d.active + (k === 'Alt+]' ? 1 : -1), 0, d.layers.length - 1)))() },
  { group: G.layers, keys: ['Ctrl+,'], text: N_('Show / hide the layer'), run: onDoc((d) => Paint.layerOp.set(d.active, 'visible', !d.layers[d.active].visible)) },
  { group: G.layers, keys: ['Ctrl+/'], text: N_('Lock / unlock the layer'), run: clickBtn('#lLock') },
  { group: G.layers, keys: ['Ctrl+G'], text: N_('Clip the layer to the one below / unclip it'), run: clickBtn('#lClip') },
  { group: G.layers, keys: ['Ctrl+Shift+F'], text: N_('Fabric look… (folds, fabric grain, bend)'), run: clickBtn('#lFabric') },
  { group: G.layers, keys: ['F2'], text: N_('Rename layer'), run: clickBtn('#lRename') },
  { group: G.layers, keys: ['Delete'], text: N_('Delete the layer (Undo brings it back)'), run: clickBtn('#lDel') },

  { group: G.view, keys: ['F', 'Ctrl+0'], text: N_('Fit the texture in the view'), run: () => fit() },
  { group: G.view, keys: ['Ctrl+1'], text: N_('100% zoom'), run: clickBtn('#z100') },
  { group: G.view, keys: ['Ctrl+=', 'Ctrl+Shift+=', 'Ctrl++'], show: [['Ctrl', '+'], ['Ctrl', '-']], text: N_('Zoom in / out'), run: () => zoomCenter(1.25) },
  { group: G.view, keys: ['Ctrl+-'], hidden: true, run: () => zoomCenter(0.8) },
  { group: G.view, keys: ['U'], text: N_('UV guide on / off'), run: () => toggleBox('#oGuide') },

  { group: G.help, keys: ['F1'], match: (e) => e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey, show: [['F1'], ['?']], text: N_('This list of keyboard shortcuts'), run: () => showShortcuts() },
];

const KEY_HINTS = [
  { group: G.tools, show: [['Alt', { m: N_('click') }]], text: N_('Pick a colour from the texture, with any tool') },
  { group: G.paint, show: [['Shift', { m: N_('drag') }]], text: N_('Line, rectangle, oval: straight angles, a square, a circle') },
  { group: G.view, show: [['Space', { m: N_('drag') }]], text: N_('Move the view') },
  { group: G.view, show: [[{ m: N_('mouse wheel') }]], text: N_('Zoom (with the Move tool: scale the layer)') },
  { group: G.view, show: [['F11']], text: N_('3D view full screen (Esc leaves it)') },
  { group: G.modes, show: [['Ctrl', 'Enter'], ['Escape']], text: N_('Text tool: place the text / cancel it') },
  { group: G.modes, show: [['Enter'], ['Escape']], text: N_('Resize tool: apply / cancel') },
  { group: G.modes, show: [[{ m: N_('arrow keys') }], ['Shift', { m: N_('arrow keys') }]], text: N_('Resize tool: move the layer 1 / 10 pixels') },
];

/** The pieces in the order of the Pack list (male first) that the filter box shows and that have a texture. */
function listedPieces() {
  if (!S.pack) return [];
  const q = (S.filter || '').trim().toLowerCase();
  return ['male', 'female'].flatMap((g) => S.pack.items.filter((i) => i.gender === g && i.variants.length && (!q || `${g} ${i.group} ${i.label} ${i.comp}`.toLowerCase().includes(q))));
}
/** PageDown / PageUp: the next / previous texture, on into the next / previous piece. */
function stepTexture(dir) {
  const flat = listedPieces().flatMap((it) => it.variants.map((v) => ({ it, v })));
  if (!flat.length) return;
  const i = S.sel ? flat.findIndex((x) => x.it === S.sel.item && x.v === S.sel.variant) : -1;
  const n = flat[i < 0 ? 0 : clamp(i + dir, 0, flat.length - 1)];
  if (!(S.sel && n.v === S.sel.variant)) selectVariant(n.it, n.v);
}
/** Ctrl+PageDown / Ctrl+PageUp: the first texture of the next / previous piece. */
function stepPiece(dir) {
  const list = listedPieces();
  if (!list.length) return;
  const i = S.sel ? list.indexOf(S.sel.item) : -1;
  const it = list[i < 0 ? 0 : clamp(i + dir, 0, list.length - 1)];
  if (!(S.sel && it === S.sel.item)) selectVariant(it, it.variants[0]);
}

/** F1: every shortcut, grouped. */
function showShortcuts() {
  const groups = Object.values(G).map((name) => ({ name, rows: [] }));          // in the order of G, Help last
  for (const s of [...SHORTCUTS.filter((x) => !x.hidden), ...KEY_HINTS]) groups.find((x) => x.name === s.group).rows.push(s);
  for (let i = groups.length - 1; i >= 0; i--) if (!groups[i].rows.length) groups.splice(i, 1);
  const grid = el('div', 'keysgrid');
  for (const g of groups) {
    const sec = el('section', 'keysgroup');
    sec.append(el('h5', '', t(g.name)));
    const tbl = el('table', 'keystable');
    for (const s of g.rows) {
      const keys = el('td', 'k');
      (s.show || s.keys.map((k) => k.split('+'))).forEach((parts, i) => {
        if (i) keys.append(document.createTextNode(s.showSep ? ` ${s.showSep} ` : ' / '));
        parts.forEach((p, j) => {
          if (j) keys.append(document.createTextNode('+'));
          keys.append(typeof p === 'object' ? el('span', 'kmouse', t(p.m)) : el('kbd', '', keyName(p)));
        });
      });
      const tr = el('tr');
      tr.append(keys, el('td', '', t(s.text)));
      tbl.append(tr);
    }
    sec.append(tbl);
    grid.append(sec);
  }
  return modal({ title: t('Keyboard shortcuts'), wide: true, content: grid, buttons: [{ id: 'cancel', label: t('Close') }] });
}

function wireKeys() {
  window.addEventListener('keydown', (e) => {
    if (dialogOpen()) return;
    if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
    if (e.key === 'Escape' && S.fs) { e.preventDefault(); setFull(false); return; }
    // only text boxes swallow shortcuts; clicking a checkbox, slider or drop-down must not switch Ctrl+S / Ctrl+Z / tool keys off
    const ae = document.activeElement, tag = ae && ae.tagName;
    const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|number|search|email|url|tel|password)$/i.test(ae.type)) || !!(ae && ae.isContentEditable);
    if (e.key === ' ' && !typing) { S.space = true; $('#viewport').style.cursor = 'grab'; e.preventDefault(); return; }
    if (typing) return;
    if (!(e.ctrlKey || e.metaKey || e.altKey) && Paint.opts.tool === 'transform' && Paint.doc && Paint.xformState()) {
      if (e.key === 'Enter') { e.preventDefault(); applyTransform(); return; }
      if (e.key === 'Escape') { e.preventDefault(); cancelTransform(); return; }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[e.key]) {
        e.preventDefault();
        const st = Paint.xformState(), n = e.shiftKey ? 10 : 1;
        Paint.xformSet({ cx: st.cx + arrows[e.key][0] * n, cy: st.cy + arrows[e.key][1] * n }, true);
        return;
      }
    }
    const combo = comboOf(e);
    const s = SHORTCUTS.find((x) => shortcutMatches(x, e, combo));
    if (!s) return;
    e.preventDefault();
    s.run(e, combo);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') { S.space = false; setTool(Paint.opts.tool); }
  });
}

// ---------------------------------------------------------------- language
/** The texts the program changed itself (not the static ones: showLanguage translated those) are written again in the new language. */
function refreshLanguage() {
  const code = getLanguage(), l = LANGUAGES.find((x) => x.code.toLowerCase() === code.toLowerCase());
  $('#btnLang').textContent = '🌐 ' + (l ? l.short : code.toUpperCase());
  for (const o of $('#lBlend').options) { const b = Paint.BLENDS.find((x) => x && x[0] === o.value); if (b) o.textContent = t(b[1]); }
  $('#vFull').textContent = S.fs ? t('Exit') : t('Full');
  updateBodyButton(); updatePopButton(); updateViewInfo();
  if (S.pack) localizePack(S.pack);
  updatePackName(); refreshYmt();
  if (S.sel) { $('#current').textContent = currentLabel(); showTexSize(S.sel); }
  if (S.emptyMsg && !$('#empty').hidden) $('#empty').textContent = t(S.emptyMsg);
  renderTree(); renderLayers(); syncXformUi();
}

/** Switch the whole editor to a language: its code, or '' for "automatic" (the language of the system). */
async function switchLanguage(choice) {
  let info = { system: [] };
  try { info = (await api.getLanguage()) || info; } catch { /* ignore */ }
  const code = choice || pickLanguage(null, info.system);
  try { await api.setLanguage(choice, true); if (!choice) await api.setLanguage(code, false); } catch { /* the dialogs of the main process stay as they were */ }
  await showLanguage(code);
  refreshLanguage();
  if (S.pop) { api.viewerSend({ type: 'lang', code }); api.viewerSend({ type: 'label', label: $('#current').textContent }); }
  return code;
}

async function chooseLanguage() {
  let saved = '';
  try { saved = ((await api.getLanguage()) || {}).saved || ''; } catch { /* ignore */ }
  const pick = await modal({
    title: t('Language'),
    wide: true,
    lines: [t('Choose the language of ClothingStudio. The translations were made with machine translation and may contain mistakes.')],
    content: (finish) => {
      const grid = el('div', 'langgrid');
      const item = (code, name, sub) => {
        const b = el('button', 'lang' + (code === saved ? ' sel' : ''));
        if (code) b.setAttribute('lang', code);
        b.append(el('span', 'ln', name));
        if (sub) b.append(el('span', 'le', sub));
        b.onclick = () => finish(code || '__auto');
        grid.append(b);
      };
      item('', t('Automatic'), t('the language of this PC'));
      for (const l of LANGUAGES) item(l.code, l.name, l.name === l.english ? '' : l.english);
      return grid;
    },
    buttons: [{ id: 'cancel', label: t('Cancel') }],
  });
  if (pick) await switchLanguage(pick === '__auto' ? '' : pick);
}

// ---------------------------------------------------------------- boot
async function boot() {
  await startLanguage(api);                         // first, so nothing is drawn in English that should not be
  Paint.attach($('#view'), $('#overlay'));
  Paint.on('layers', () => { renderLayers(); ensureTransform(); syncXformUi(); syncTextUi(); });
  Paint.on('xform', syncXformUi);
  Paint.on('resize', onDocResized);              // the resolution changed: a resize, or Undo / Redo of one
  Paint.on('change', onChange);
  Paint.on('pick', (c) => setColor(c));
  Paint.on('doc', () => textEnd(false));         // safety net: a different document never inherits an open text box
  Paint.translate = t;                           // the engine writes its messages in English; this is how they get translated
  Paint.on('warn', (m) => toast(tm(m), 'warn'));
  Paint.on('note', (m) => toast(tm(m), 'info', 9000));   // things the paint engine did for you that you should know about

  viewer = new Viewer($('#viewer3d'));
  try {
    const st = await api.bodyStatus();
    S.gta = (st && st.gtaDir) || null;
  } catch { S.gta = null; }
  let pref = '1';
  try { pref = localStorage.getItem('cs.body') || '1'; } catch { /* ignore */ }
  S.bodyOn = !!S.gta && pref !== '0';
  updateBodyButton();
  $('#vBody').onclick = toggleBody;
  if (api.onBodyProgress) api.onBodyProgress((t) => setMsg(t));
  $('#vReset').onclick = () => viewer.frame();
  $('#vWire').onclick = (e) => { e.currentTarget.classList.toggle('on'); viewer.setWireframe(e.currentTarget.classList.contains('on')); };
  $('#vBack').onclick = () => viewer.toggleBackground();
  $('#vFull').onclick = toggleFullscreen;
  $('#vPop').onclick = togglePopout;
  if (api.onViewerMessage) api.onViewerMessage(onPopMessage);

  $('#btnOpen').onclick = openPackDialog;
  $('#ymtChip').onclick = showYmt;
  $('#btnOptions').onclick = () => { if (S.sel) openOptions(S.sel.item); };
  try { S.collapsed = new Set(JSON.parse(localStorage.getItem('cs.collapsed') || '[]')); } catch { /* ignore */ }
  $('#treeFilter').addEventListener('input', (e) => { S.filter = e.target.value; renderTree(); });
  $('#pAdd').onclick = () => addPiecesFlow();
  $('#pNew').onclick = newPackUi;
  $('#pBuild').onclick = buildPackUi;
  $('#btnSave').onclick = saveToYtd;
  $('#btnLang').onclick = chooseLanguage;
  $('#btnKeys').onclick = () => showShortcuts();
  $('#btnExport').onclick = exportPng;
  $('#btnProjSave').onclick = saveProject;
  $('#btnProjOpen').onclick = openProject;
  $('#btnUndo').onclick = () => { if (S.text) textEnd(false); else if (Paint.doc) Paint.undo(); };
  $('#btnRedo').onclick = () => { if (S.text) textEnd(false); else if (Paint.doc) Paint.redo(); };

  wireViewport(); wireOptions(); wireColor(); wireLayerPanel(); wireTransformBar(); wireDrop(); wireKeys();
  setTool('brush');
  renderTree();
  refreshLanguage();

  window.csDirty = () => [...S.docs.values()].some((e) => e.doc.dirty);
  window.__cs = { S, Paint, viewer, selectVariant, loadPack, setColor, setTool, ensureTransform, movePieceUi, deletePieceUi, afterPieceOp, openPieceMenu, showYmt, refreshYmt, openOptions, switchLanguage, chooseLanguage, copyTextureUi, showShortcuts, TXT, textBegin, textEnd, textRefresh, syncTextUi, textEditLayer, textHit };

  if (!api.isDesktop) {
    const p = await api.openPack().catch(() => null);
    if (p) loadPack(p);
    else setMsg(t('Dev mode: add ?pack=<folder> to the URL to load a resource.'));
  }
}

/**
 * Operations that change files on disk run one at a time: a second click while one is still working (or a dialog of
 * it is open) is ignored instead of racing it with stale pieces.
 */
function withOp(fn) {
  return async function guarded(...args) {
    if (S.opBusy) { toast(t('Wait for the current operation to finish first.'), 'warn', 2500); return undefined; }
    if (S.busy) { toast(t('A piece is still loading - try again in a second.'), 'warn', 2500); return undefined; }
    S.opBusy = true;
    try { return await fn.apply(this, args); } finally { S.opBusy = false; }
  };
}
movePieceUi = withOp(movePieceUi);
deletePieceUi = withOp(deletePieceUi);
importTexturesUi = withOp(importTexturesUi);
openOptions = withOp(openOptions);
addPiecesFlow = withOp(addPiecesFlow);
addVariant = withOp(addVariant);
deleteVariant = withOp(deleteVariant);
copyTextureUi = withOp(copyTextureUi);
buildPackUi = withOp(buildPackUi);

boot().catch((e) => { console.error(e); toast(t('Startup error: {error}', { error: e.message }), 'error', 20000); });
