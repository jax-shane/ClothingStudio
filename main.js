'use strict';
const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const { scanPack, parseName, walk } = require('./src/lib/pack');
const ymtLib = require('./src/lib/ymt');
const packops = require('./src/lib/packops');
const { readYdd } = require('./src/lib/ydd');
const ytd = require('./src/lib/ytd');
const { detectGtaDir } = require('./src/lib/body');

let win = null;

// ---- settings (GTA folder) -------------------------------------------------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 1)); } catch { /* not fatal */ }
}

// ---- body mannequin: archive reading runs in a worker so the window stays responsive
let bodyWorker = null, bodyReq = 0;
const bodyPending = new Map();
function ensureBodyWorker() {
  if (bodyWorker) return bodyWorker;
  const w = new Worker(path.join(__dirname, 'src', 'lib', 'body-worker.js'));
  w.on('message', (m) => {
    const p = bodyPending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') { if (win && !win.isDestroyed()) win.webContents.send('body:progress', m.text); return; }
    bodyPending.delete(m.id);
    if (m.type === 'result') p.resolve(m.data); else p.reject(new Error(m.message));
  });
  w.on('error', (e) => { for (const p of bodyPending.values()) p.reject(e); bodyPending.clear(); bodyWorker = null; });
  w.on('exit', () => { bodyWorker = null; });
  bodyWorker = w;
  return w;
}
const allowedRoots = new Set(); // only files inside a pack the user opened can be read or written

function inside(p) {
  const full = path.resolve(String(p));
  for (const root of allowedRoots) {
    const rel = path.relative(root, full);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return full;
  }
  throw new Error('That file is outside the opened pack.');
}

function register(root) {
  allowedRoots.add(path.resolve(root));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1560, height: 940, minWidth: 1180, minHeight: 720,
    backgroundColor: '#14161a', title: 'ClothingStudio',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { if (pop && !pop.isDestroyed()) pop.destroy(); }); // the 3D pop-out never outlives the editor

  // warn before closing with unsaved painting (a beforeunload prompt would make the window unclosable)
  let forceClose = false;
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    const quit = () => { forceClose = true; win.close(); };
    win.webContents.executeJavaScript('window.csDirty ? window.csDirty() : false').then((dirty) => {
      if (!dirty) return quit();
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['Discard painting and quit', 'Cancel'], defaultId: 1, cancelId: 1,
        message: 'You have painting that is not saved to a .ytd or a layers file.',
      });
      if (r === 0) quit();
    }).catch(quit);
  });
}

// ---- pop-out 3D window (the editor pushes the scene + live texture; this window only renders)
let pop = null;
const toMain = (msg) => { if (win && !win.isDestroyed()) win.webContents.send('viewer:msg', msg); };
const toPop = (msg) => { if (pop && !pop.isDestroyed()) pop.webContents.send('viewer:msg', msg); };

function openPopout() {
  const displays = screen.getAllDisplays();
  if (pop && !pop.isDestroyed()) {
    if (pop.isMinimized()) pop.restore();
    pop.focus();
    return { reused: true, displays: displays.length };
  }
  const here = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  const other = displays.find((d) => d.id !== here.id) || null;   // prefer a different monitor than the editor's
  const wa = (other || here).workArea;
  pop = new BrowserWindow({
    x: wa.x + (other ? 0 : 60), y: wa.y + (other ? 0 : 60),
    width: other ? wa.width : Math.max(640, Math.min(1100, wa.width - 120)),
    height: other ? wa.height : Math.max(480, Math.min(860, wa.height - 120)),
    minWidth: 480, minHeight: 360, backgroundColor: '#0d0f12', title: 'ClothingStudio - 3D view',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  pop.setMenuBarVisibility(false);
  pop.loadFile(path.join(__dirname, 'renderer', 'viewer-window.html'));
  if (other) pop.maximize();
  pop.on('closed', () => { pop = null; toMain({ type: 'closed' }); });
  return { reused: false, displays: displays.length, onOther: !!other };
}

// full screen for whichever window asks (editor or pop-out); a window that was already full screen stays so
const wasFull = new WeakMap();
ipcMain.handle('win:fullscreen', (e, on) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return false;
  if (on) { wasFull.set(w, w.isFullScreen()); w.setFullScreen(true); }
  else if (!wasFull.get(w)) w.setFullScreen(false);
  return !!on;
});

ipcMain.handle('viewer:open', () => openPopout());
ipcMain.handle('viewer:close', () => { if (pop && !pop.isDestroyed()) pop.close(); });
ipcMain.on('viewer:send', (e, msg) => {
  if (pop && !pop.isDestroyed() && e.sender === pop.webContents) toMain(msg); else toPop(msg);
});

ipcMain.handle('pack:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a clothing resource folder (the one that contains stream/)',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return openPackFolder(r.filePaths[0]);
});

// Paths the page may ask the main process to open: folders the user chose in a dialog, and files / folders dragged onto
// the window (the preload reports those from the real File objects, so the page cannot invent them).
const droppedPaths = new Set();
ipcMain.on('drop:path', (_e, p) => { if (typeof p === 'string' && p) droppedPaths.add(path.resolve(p)); });
const inOpenedPack = (p) => { const f = path.resolve(String(p)); for (const r of allowedRoots) { const rel = path.relative(r, f); if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true; } return false; };
const mayImport = (p) => droppedPaths.has(path.resolve(String(p))) || inOpenedPack(p);

ipcMain.handle('pack:scan', (_e, folder) => {
  const full = path.resolve(String(folder));
  if (!allowedRoots.has(full) && !droppedPaths.has(full)) throw new Error('Open a pack with "Open pack…" or drop its folder on the window.');
  return openPackFolder(full);
});

/** register the folder, undo what an interrupted operation left half done, scan it */
function openPackFolder(folder) {
  register(folder);
  let recovered = null;
  try { recovered = packops.recoverPack(path.resolve(folder)); } catch { /* not fatal */ }
  const pack = scanPack(folder);
  if (recovered && (recovered.rolledBack || recovered.restored.length || recovered.stuck.length)) pack.recovered = recovered;
  return pack;
}

ipcMain.handle('mesh:load', (_e, file) => readYdd(inside(file)));

ipcMain.handle('tex:load', (_e, file) => ytd.decodeTexture(ytd.readYtd(inside(file)), 0));

ipcMain.handle('tex:save', (_e, file, rgba, opts) => {
  const full = inside(file);
  if (!full.toLowerCase().endsWith('.ytd')) throw new Error('Not a .ytd file.');
  return ytd.patchTexture(full, 0, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { backup: !(opts && opts.backup === false) });
});

// New texture variant: copy a variant's .ytd to the next free letter (a -> b -> c ...) next to it.
// The texture name stored *inside* the file is left alone - the pack's own b files share the a file's inner name.
ipcMain.handle('variant:add', (_e, srcYtd, usedLetters) => {
  const full = inside(srcYtd);
  const p = parseName(full);
  if (!p || p.type !== 'ytd') throw new Error('That is not a clothing texture this app recognises.');
  const dir = path.dirname(full), base = path.basename(full);
  const used = new Set((Array.isArray(usedLetters) ? usedLetters : []).map((l) => String(l).toLowerCase()));
  for (const n of fs.readdirSync(dir)) { // letters already on disk beside the source also count
    const q = parseName(path.join(dir, n));
    if (q && q.type === 'ytd' && q.gender === p.gender && q.prop === p.prop && q.comp === p.comp && q.drawable === p.drawable && (q.race || null) === (p.race || null)) used.add(q.letter);
  }
  used.add(p.letter);
  const top = Math.max(...[...used].map((l) => l.charCodeAt(0)));
  if (top >= 'z'.charCodeAt(0)) throw new Error('There are no letters left after z for this piece.');
  const letter = String.fromCharCode(top + 1);
  const m = (p.prop ? /^(.*_diff_\d{3}_)([a-z])(\.ytd)$/i : /^(.*_diff_\d{3}_)([a-z])(_[a-z]{3}\.ytd)$/i).exec(base);
  if (!m) throw new Error('Could not work out the new file name from ' + base);
  const target = path.join(dir, m[1] + letter + m[3]);
  fs.copyFileSync(full, target, fs.constants.COPYFILE_EXCL); // never overwrites an existing file
  return { file: target, letter, race: p.race || null };
});

// Delete a texture variant (any letter of a piece that has at least two) into the Recycle Bin - never a permanent
// delete. The textures after it then move down one slot (delete c from a,b,c,d and d becomes the new c) so the
// letters stay in order. Returns the renames so the editor can follow its open paintings to their new files.
ipcMain.handle('variant:delete', async (_e, ytdPath) => {
  const full = inside(ytdPath);
  const p = parseName(full);
  if (!p || p.type !== 'ytd') throw new Error('That is not a clothing texture this app recognises.');
  if (!fs.existsSync(full)) throw new Error('That file is already gone.');
  const dir = path.dirname(full), base = path.basename(full);
  const same = (q) => q && q.type === 'ytd' && q.gender === p.gender && q.prop === p.prop && q.comp === p.comp && q.drawable === p.drawable && (q.race || null) === (p.race || null);
  const nameFor = (letter) => {
    const m = (p.prop ? /^(.*_diff_\d{3}_)([a-z])(\.ytd)$/i : /^(.*_diff_\d{3}_)([a-z])(_[a-z]{3}\.ytd)$/i).exec(base);
    if (!m) throw new Error('Could not work out the file name for texture ' + letter);
    return path.join(dir, m[1] + letter + m[3]);
  };
  const letters = new Set([p.letter]);
  for (const n of fs.readdirSync(dir)) { const q = parseName(path.join(dir, n)); if (same(q)) letters.add(q.letter); }
  if (letters.size < 2) throw new Error('A piece needs at least one texture, so its only texture cannot be deleted.');

  const order = [...letters].sort();
  const at = order.indexOf(p.letter);
  const moves = order.slice(at + 1).map((from, i) => ({ from: nameFor(from), to: nameFor(order[at + i]), letter: order[at + i] }));
  for (const m of moves) { // every file that has to move must exist, and every slot must be free once the chain runs
    if (!fs.existsSync(m.from)) throw new Error('Expected ' + path.basename(m.from) + ' but it is missing; nothing was changed.');
  }
  // The file goes to the Recycle Bin under its real name; a temp copy makes the whole thing undoable if a later rename fails.
  const doomed = [full, full + '.bak'].filter((f) => fs.existsSync(f));
  const backupDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs_vdel_'));
  const backups = doomed.map((f, i) => ({ f, b: path.join(backupDir, i + '_' + path.basename(f)) }));
  for (const { f, b } of backups) fs.copyFileSync(f, b);
  const trashed = [], renames = [], done = [];
  try {
    for (const { f } of backups) { await shell.trashItem(f); trashed.push(f); }
    for (const m of moves) {                   // ascending, so each target slot has just been freed
      if (fs.existsSync(m.to)) throw new Error('Cannot move ' + path.basename(m.from) + ' because ' + path.basename(m.to) + ' is in the way.');
      fs.renameSync(m.from, m.to); done.push([m.from, m.to]);
      if (fs.existsSync(m.from + '.bak') && !fs.existsSync(m.to + '.bak')) { fs.renameSync(m.from + '.bak', m.to + '.bak'); done.push([m.from + '.bak', m.to + '.bak']); }
      renames.push(m);
    }
  } catch (e) {
    for (const [a, b] of done.reverse()) { try { fs.renameSync(b, a); } catch { /* best effort */ } }
    for (const { f, b } of backups) if (!fs.existsSync(f)) { try { fs.copyFileSync(b, f); } catch { /* the Recycle Bin copy remains */ } }
    throw e;
  } finally { try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* temp folder */ } }
  return { trashed, letter: p.letter, renames };
});

// ---- pieces: delete / move / add, new pack, build a FiveM resource
// Files the user picked in a dialog (or dropped) are handed to the page as tokens, never as paths it could change.
const picked = new Map();
let pickSeq = 0;
const regPick = (p) => { const t = 'f' + (++pickSeq); picked.set(t, p); return t; };
const resolvePick = (t) => { const p = picked.get(t); if (!p || !fs.existsSync(p)) throw new Error('That file is no longer available - pick it again.'); return p; };
const openedPack = (root) => { const full = path.resolve(String(root)); if (!allowedRoots.has(full)) throw new Error('That folder is not an opened pack.'); return full; };
const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

const yddInfo = (p) => ({ token: regPick(p), ...packops.guessYdd(p) });

ipcMain.handle('ydd:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the .ydd model(s) to add', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Drawable models', extensions: ['ydd'] }] });
  return r.canceled ? [] : r.filePaths.map(yddInfo);
});
ipcMain.handle('ydd:register', (_e, paths) => (Array.isArray(paths) ? paths : []).filter((p) => /\.ydd$/i.test(String(p)) && fs.existsSync(p) && mayImport(p)).map(yddInfo));

ipcMain.handle('tex:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose textures (PNG, JPG, WEBP... or a ready .ytd)', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Textures', extensions: [...IMG_EXT, 'ytd'] }],
  });
  return r.canceled ? [] : r.filePaths.map((p) => ({ token: regPick(p), name: path.basename(p), kind: /\.ytd$/i.test(p) ? 'ytd' : 'image' }));
});
ipcMain.handle('tex:register', (_e, paths) => (Array.isArray(paths) ? paths : [])
  .filter((p) => new RegExp(`\\.(${[...IMG_EXT, 'ytd'].join('|')})$`, 'i').test(String(p)) && fs.existsSync(p) && mayImport(p))
  .map((p) => ({ token: regPick(p), name: path.basename(p), kind: /\.ytd$/i.test(p) ? 'ytd' : 'image' })));
ipcMain.handle('file:dataUrl', (_e, token) => {
  const f = resolvePick(token), ext = path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg');
  if (!IMG_EXT.includes(ext.replace('jpeg', 'jpg'))) throw new Error('Not an image file.');
  return `data:image/${ext};base64,` + fs.readFileSync(f).toString('base64');
});

const resolveTextures = (list) => (list || []).map((t) => (t.kind === 'ytd' ? { kind: 'ytd', path: resolvePick(t.token) } : t));

ipcMain.handle('piece:template', (_e, root, gender, prop, comp, itemId) => {
  const pack = scanPack(openedPack(root));
  const item = itemId ? pack.items.find((i) => i.id === itemId) : null;
  const t = packops.findTemplate(pack, gender, !!prop, comp, item);
  return { width: t.width, height: t.height, format: t.format };
});
ipcMain.handle('piece:options', (_e, root, itemId) => packops.getPieceOptions(openedPack(root), itemId));
ipcMain.handle('piece:setOptions', (_e, root, itemId, o) => {
  const clean = {};   // only the known fields, with the right types
  if (o && typeof o.audio === 'string') clean.audio = o.audio;
  if (o && o.flags !== undefined) clean.flags = Number(o.flags);
  if (o && typeof o.renderFlag === 'string') clean.renderFlag = o.renderFlag;
  if (o && o.hasSkin !== undefined) clean.hasSkin = !!o.hasSkin;
  for (const k of ['hairScale', 'heels']) if (o && o[k]) clean[k] = { enabled: !!o[k].enabled, value: Number(o[k].value) };
  return packops.setPieceOptions(openedPack(root), itemId, clean);
});
ipcMain.handle('piece:add', (_e, root, spec) => packops.addPiece(openedPack(root), { ...spec, ydd: resolvePick(spec.yddToken), textures: resolveTextures(spec.textures) }));
ipcMain.handle('piece:addTextures', (_e, root, itemId, textures) => packops.addTextures(openedPack(root), itemId, resolveTextures(textures)));
ipcMain.handle('piece:delete', (_e, root, itemId) => packops.deletePiece(openedPack(root), itemId, { trash: (f) => shell.trashItem(f) }));
ipcMain.handle('piece:move', (_e, root, itemId, to) => packops.movePiece(openedPack(root), itemId, to));

ipcMain.handle('pack:new', async (_e, name) => {
  if (!packops.validName(name)) throw new Error('Use letters, digits and underscores only (for example my_clothes), up to 40 characters.');
  const r = await dialog.showOpenDialog(win, { title: `Where should the "${name}" folder be created?`, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const made = packops.createPack(r.filePaths[0], name);
  register(made.root);
  return scanPack(made.root);
});

ipcMain.handle('pack:build', async (_e, root, name) => {
  const full = openedPack(root);
  if (!packops.validName(name)) throw new Error('Use letters, digits and underscores only for the resource name (up to 40 characters).');
  const r = await dialog.showOpenDialog(win, { title: 'Choose the folder to build the FiveM resource into (a folder named after the resource is created inside it)', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return packops.buildResource(full, path.join(r.filePaths[0], name), name);
});

// ---- the pack's ped variation .ymt (how many textures the game offers for each piece)
function packYmts(root) {
  const full = path.resolve(String(root));
  if (!allowedRoots.has(full)) throw new Error('That folder is not an opened pack.');
  const pack = scanPack(full);
  // the same lookup the piece operations use, so the chip and the edits always talk about the same file
  return ['male', 'female'].map((gender) => ({ gender, file: packops.findYmt(full, pack.dlcName, gender), items: pack.items.filter((i) => i.gender === gender) }));
}

ipcMain.handle('ymt:status', (_e, root) => {
  const genders = packYmts(root).map(({ gender, file, items }) => {
    if (!file) return { gender, file: null, diffs: [], missing: [] };
    try {
      const { diffs, missing } = ymtLib.compare(ymtLib.readYmt(file), items);
      return { gender, file: path.basename(file), diffs, missing };
    } catch (e) { return { gender, file: path.basename(file), diffs: [], missing: [], error: String(e.message || e) }; }
  });
  return { genders };
});

// opts: { gender?: 'male'|'female', only?: pieceId } - makes the texture counts in the .ymt match the files in the pack
ipcMain.handle('ymt:sync', (_e, root, opts) => {
  const results = [];
  for (const { gender, file, items } of packYmts(root)) {
    if (opts && opts.gender && opts.gender !== gender) continue;
    if (!file) { results.push({ gender, file: null }); continue; }
    try {
      const model = ymtLib.readYmt(file);
      // a full update also lists pieces that have files but are missing from the .ymt; a single-piece update does not
      const added = opts && opts.only ? [] : ymtLib.ensureListed(model, items).map((i) => ({ id: i.id, label: i.label + ' (added)', from: 0, to: i.variants.length }));
      const changes = [...added, ...ymtLib.applyCounts(model, items, opts && opts.only)];
      if (!changes.length) { results.push({ gender, file: path.basename(file), changes: [] }); continue; }
      const w = ymtLib.writeYmt(file, model);
      results.push({ gender, file: path.basename(file), changes, backup: w.backup ? path.basename(w.backup) : null });
    } catch (e) { results.push({ gender, file: path.basename(file), error: String(e.message || e) }); }
  }
  return { results };
});

ipcMain.handle('body:status', () => ({ gtaDir: detectGtaDir(readSettings().gtaDir) }));

ipcMain.handle('body:setDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose your Grand Theft Auto V folder (contains GTA5.exe)', properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  if (!fs.existsSync(path.join(dir, 'GTA5.exe')) || !fs.existsSync(path.join(dir, 'x64a.rpf'))) {
    throw new Error('That folder does not contain GTA5.exe and the x64*.rpf archives (only the legacy edition is supported).');
  }
  writeSettings({ ...readSettings(), gtaDir: dir });
  return dir;
});

ipcMain.handle('body:load', (_e, gender) => {
  const dir = detectGtaDir(readSettings().gtaDir);
  if (!dir) throw new Error('Your GTA V folder was not found. Use "Set GTA V folder…".');
  return new Promise((resolve, reject) => {
    const id = ++bodyReq;
    bodyPending.set(id, { resolve, reject });
    ensureBodyWorker().postMessage({
      type: 'load', id, gtaDir: dir, gender: gender === 'female' ? 'female' : 'male',
      keyCache: path.join(app.getPath('userData'), 'keys.bin'),
    });
  });
});

ipcMain.handle('png:save', async (_e, name, dataUrl) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Export PNG', defaultPath: String(name || 'texture.png'),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
  return r.filePath;
});

ipcMain.handle('project:save', async (_e, name, json) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save layered project', defaultPath: String(name || 'design.csproj'),
    filters: [{ name: 'ClothingStudio project', extensions: ['csproj'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, json, 'utf8');
  return r.filePath;
});

ipcMain.handle('project:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open layered project', properties: ['openFile'],
    filters: [{ name: 'ClothingStudio project', extensions: ['csproj'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return fs.readFileSync(r.filePaths[0], 'utf8');
});

ipcMain.handle('image:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import image', properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const f = r.filePaths[0];
  const ext = path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg');
  return `data:image/${ext};base64,` + fs.readFileSync(f).toString('base64');
});

// CS_SMOKE_MODE=shots: stages the app in a few states and saves screenshots (used for the README / docs images)
async function runShots(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (js) => win.webContents.executeJavaScript(js);
  const rectOf = (sel, pad = 6) => run(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.max(0, Math.floor(b.left) - ${pad}), y: Math.max(0, Math.floor(b.top) - ${pad}), width: Math.ceil(b.width) + ${pad * 2}, height: Math.ceil(b.height) + ${pad * 2} }; })()`);
  const shot = async (name, rect, wait = 800) => {
    await sleep(wait);
    await run(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);   // let the page paint what it just changed
    win.webContents.invalidate();
    await sleep(120);
    const img = rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
    const st = await run(`JSON.stringify({ modalHidden: document.querySelector('#modal').hidden, panel: document.querySelector('#viewerPanel').className, fs: window.__cs.S.fs })`).catch((e) => String(e));
    fs.appendFileSync(path.join(outDir, 'shots.log'), `${name}: ${st}\n`);
  };
  const PK = JSON.stringify(process.env.CS_SMOKE_PACK);
  win.setSize(1600, 960); win.center();
  await sleep(500);
  await run(`(async () => { await window.__cs.loadPack(await window.api.scanPack(${PK})); })()`);
  await sleep(1500);

  // 1. paint a red band on the hat, full window
  await run(`(async () => { const cs = window.__cs, P = cs.Paint; cs.setTool('brush'); cs.setColor('#c92a2a'); P.opts.size = 120; P.opts.hardness = 1; P.opts.opacity = 1;
    P.down({ x: 120, y: 232, pressure: 1 }, {}); P.move({ x: 1880, y: 232, pressure: 1 }, {}); P.up({ x: 1880, y: 232 }, {}); cs.setColor('#2f9e44'); })()`);
  await shot('overview');
  await shot('pack-list', await rectOf('#left', 0), 100);
  await run(`window.__cs.setColor('#4c6ef5')`);
  await shot('color-wheel', await rectOf('.panel.color', 0), 200);

  // 1b. the Text tool: type on the texture, then place it on its own layer
  await run(`(async () => { const cs = window.__cs; cs.setColor('#fcc419'); cs.setTool('text');
    Object.assign(cs.TXT, { family: 'Impact', size: 190, bold: false, italic: false, align: 'center', stroke: 7, strokeColor: '#1c3d7a', shadow: true, shadowColor: '#000000', shadowBlur: 12, shadowX: 9, shadowY: 9, caps: true, spacing: 4, leading: 105, rot: -6, flipH: false, flipV: false, underline: false, strike: false }); cs.syncTextUi();
    cs.textBegin(700, 1010); const ta = document.querySelector('#textBox'); ta.value = 'STATE POLICE\\nPATROL'; ta.dispatchEvent(new Event('input')); })()`);
  await shot('text-tool', await rectOf('#center', 0), 500);
  await run(`window.__cs.textEnd(true); window.__cs.setTool('brush')`);

  // 2. a logo layer, the Resize tool with its handles, a locked base layer
  await run(`(async () => { const cs = window.__cs, P = cs.Paint;
    const c = document.createElement('canvas'); c.width = c.height = 600; const g = c.getContext('2d');
    g.fillStyle = '#f8f9fa'; g.beginPath(); g.arc(300, 300, 290, 0, 7); g.fill();
    g.fillStyle = '#1c7ed6'; g.beginPath(); g.arc(300, 300, 250, 0, 7); g.fill();
    g.fillStyle = '#fcc419'; g.font = 'bold 190px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('GSP', 300, 310);
    P.addImageLayer(c, { name: 'Logo', fit: 'contain', maxFraction: 0.3 }); cs.setTool('transform');
    P.xformSet({ cx: 980, cy: 560, sx: 1.25, sy: 1.25, rot: -0.22 }, true);
    P.layerOp.set(0, 'locked', true); })()`);
  await shot('resize-tool');
  await shot('layers', await rectOf('#left .layers', 4), 100);
  await run(`window.__cs.setTool('brush')`);

  // 3. the ⋯ menu of a piece that is not open
  await run(`(async () => { const row = [...document.querySelectorAll('#tree .tree-item')].find((r) => r.querySelector('.name').textContent === 'Top 001'); row.querySelector('.chip.more').click(); })()`);
  await shot('piece-menu', { x: 0, y: 46, width: 560, height: 680 }, 400);
  await run(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);

  // 3b. the Options dialog of the hat (audio, render flag, flags, hair scale)
  await run(`(async () => { const hat = window.__cs.S.pack.items.find((i) => i.id === 'male_p_head_000'); window.__cs.openOptions(hat); })()`);
  await shot('options-dialog', null, 900);
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(300);

  // 4. the Add pieces dialog (one model that says what it is, one that does not)
  await run(`(async () => { const { addPieceDialog } = await import('./js/pieces.js'); const api = Object.assign({}, window.api, { pickTextures: async () => [{ token: 'x', name: 'chest_badge_front.png', kind: 'image' }, { token: 'y', name: 'chest_badge_alt.png', kind: 'image' }] });
    window.__dlg = addPieceDialog({ api, infos: [
      { token: 'a', name: 'jbib_003_u.ydd', gender: null, prop: false, comp: 'jbib', hasSkin: false },
      { token: 'b', name: 'chest_badge.ydd', gender: null, prop: null, comp: null, hasSkin: null }], defaultGender: 'male', toast: () => {} });
    await new Promise((r) => setTimeout(r, 300));
    const rows = [...document.querySelectorAll('.pd-row')];
    [...rows[0].querySelectorAll('button')].find((b) => b.textContent.startsWith('Add textures')).click(); })()`);
  await shot('add-pieces', null, 600);
  await run(`document.querySelector('#pdCancel').click()`);
  await sleep(300);

  // 5. the .ymt check: a texture file the .ymt does not know about yet
  await run(`(async () => { const cs = window.__cs, S = cs.S; const hat = S.pack.items.find((i) => i.id === 'male_p_head_000');
    await window.api.addVariant(hat.variants[hat.variants.length - 1].ytd, hat.variants.map((v) => v.letter)); await cs.refreshYmt(); cs.showYmt(); })()`);
  await shot('ymt-check', null, 700);
  await run(`[...document.querySelectorAll('#mBtns button')].find((b) => b.textContent.startsWith('Close')).click()`);
  await sleep(300);

  // 6. 3D view full size, and the pop-out window on the second monitor
  await run(`(async () => { const p = document.querySelector('#viewerPanel'); p.classList.add('fs'); window.__cs.viewer.resize(); })()`);
  await shot('fullscreen-3d', null, 900);
  await run(`(async () => { document.querySelector('#viewerPanel').classList.remove('fs'); window.__cs.viewer.resize(); await window.api.viewerOpen(); })()`);
  await sleep(5000);
  if (pop && !pop.isDestroyed()) fs.writeFileSync(path.join(outDir, 'popout.png'), (await pop.webContents.capturePage()).toPNG());
}

// CS_SMOKE_MODE=ops: drives the piece operations through the real UI functions and IPC on a pack copy
function opsSmokeJs() {
  return `(async () => {
    const PK = ${JSON.stringify(process.env.CS_SMOKE_PACK)};
    const cs = window.__cs, api = window.api, S = cs.S, out = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const clickModal = async (start) => {
      for (let i = 0; i < 60; i++) {
        const b = [...document.querySelectorAll('#mBtns button')].find((x) => x.textContent.startsWith(start));
        if (b && !document.querySelector('#modal').hidden) { b.click(); return true; }
        await sleep(100);
      }
      return false;
    };
    await cs.loadPack(await api.scanPack(PK));
    const sig = async (it) => { const m = await api.loadMesh(it.ydd); const g = m.drawables[0].models[0].geometries[0]; return g.vertexCount + '/' + g.indexCount; };
    const list = async () => { const o = []; for (const it of S.pack.items.filter((i) => i.gender === 'male' && i.comp === 'jbib')) o.push(it.drawable + '=' + await sig(it)); return o.join(' '); };
    const diffs = async () => (await api.ymtStatus(PK)).genders.map((g) => g.diffs.length + g.missing.length);
    out.start = await list(); out.ymtStart = await diffs();

    // 1. select Top 002, move it up (swap with Top 001) through the real UI function
    const t2 = S.pack.items.find((i) => i.id === 'male_jbib_002');
    await cs.selectVariant(t2, t2.variants[0]);
    S.sel.doc.dirty = true; const docOf2 = S.sel.doc;                       // pretend unsaved painting: it must follow the piece
    await cs.movePieceUi(t2, -1);
    out.afterMove = await list(); out.selAfterMove = S.sel.item.id; out.paintFollowed = S.sel.doc === docOf2 && S.sel.doc.dirty;
    out.selFile = S.sel.ytd.split(/[\\\\/]/).pop().slice(-26); out.ymtAfterMove = await diffs();

    // 2. delete Top 001 (which is the moved piece) through the real UI, confirm in the dialog
    const t1 = S.pack.items.find((i) => i.id === 'male_jbib_001');
    const pDel = cs.deletePieceUi(t1); out.confirmClicked = await clickModal('Delete piece'); await pDel;
    out.afterDelete = await list(); out.selAfterDelete = S.sel && S.sel.item.id; out.ymtAfterDelete = await diffs();

    // 3. add a piece: a model + a ready .ytd + a blank texture, through IPC like the dialog does
    const hand = S.pack.items.find((i) => i.id === 'male_hand_000');
    const y = await api.registerYdd([hand.ydd]); const t = await api.registerTextures([hand.variants[0].ytd]);
    out.guess = y[0].comp + '/' + y[0].gender + '/' + y[0].hasSkin;
    const res = await api.pieceAdd(PK, { gender: 'male', prop: false, comp: 'hand', hasSkin: false, yddToken: y[0].token, textures: [{ kind: 'ytd', token: t[0].token }, { kind: 'blank' }] });
    await cs.afterPieceOp({ selectId: res.id });
    out.added = res.id + ' ' + res.files.map((f) => f.split(/[\\\\/]/).pop().slice(-18)).join(','); out.sel = S.sel.item.id + ' x' + S.sel.item.variants.length; out.ymtAfterAdd = await diffs();

    // 4. piece options through IPC, like the Options dialog does: hat hair scale + flags, and the pants' "shows skin" (renames files)
    out.hatBefore = JSON.stringify((await api.pieceOptions(PK, 'male_p_head_000')).options.hairScale);
    await api.pieceSetOptions(PK, 'male_p_head_000', { hairScale: { enabled: true, value: 0.35 }, flags: 4096 });
    const hat2 = (await api.pieceOptions(PK, 'male_p_head_000')).options; out.hatAfter = hat2.hairScale.value.toFixed(2) + ' flags ' + hat2.flags;
    const sk = await api.pieceSetOptions(PK, 'male_lowr_000', { hasSkin: false });
    await cs.afterPieceOp({ renames: sk.renames, selectId: 'male_lowr_000' });
    out.skin = S.pack.items.find((i) => i.id === 'male_lowr_000').race + ' ' + S.sel.ytd.split(/[\\\\/]/).pop().slice(-22) + ' renames ' + sk.renames.length;
    out.ymtAfterOptions = await diffs();
    return JSON.stringify(out);
  })()`;
}

// CS_SMOKE_MODE=text: drives the Text tool and the Layers buttons through the real editor elements and checks what lands on the texture
function textSmokeJs() {
  return `(async () => {
    const cs = window.__cs, P = cs.Paint, S = cs.S, out = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await cs.loadPack(await window.api.scanPack(${JSON.stringify(process.env.CS_SMOKE_PACK)}));
    const hat = S.pack.items.find((i) => i.id === 'male_p_head_000');
    await cs.selectVariant(hat, hat.variants[0]);
    const $ = (s) => document.querySelector(s);
    const type = (s) => { const ta = $('#textBox'); ta.value = s; ta.dispatchEvent(new Event('input')); };
    const num = (id, v) => { const e = $(id); e.value = String(v); e.dispatchEvent(new Event('input')); };
    const opaque = (L) => { const d = L.ctx.getImageData(0, 0, L.canvas.width, L.canvas.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; };
    const bbox = (L) => { const w = L.canvas.width, h = L.canvas.height, d = L.ctx.getImageData(0, 0, w, h).data; let x0 = w, y0 = h, x1 = -1, y1 = -1; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
    const names = () => P.doc.layers.map((l) => l.name + (l.text ? ' [T]' : '') + (l.locked ? ' [locked]' : ''));
    const n0 = P.doc.layers.length;
    Object.assign(cs.TXT, { family: 'Arial', size: 96, bold: false, italic: false, underline: false, strike: false, caps: false, align: 'left', spacing: 0, leading: 120, rot: 0, flipH: false, flipV: false, stroke: 0, strokeColor: '#ffffff', shadow: false, shadowColor: '#000000', shadowBlur: 8, shadowX: 6, shadowY: 6 });
    cs.syncTextUi();
    cs.setTool('text'); cs.setColor('#e03131');
    out.barVisible = !$('[data-for=text]').hidden;
    out.mirrorHiddenForText = $('#oSym').closest('.opt').hidden;

    // 1. a new text: type, change font, size, bold, outline, spacing; place it
    cs.textBegin(300, 300); await sleep(50);
    out.focused = document.activeElement && document.activeElement.id;
    type('Hello');
    num('#oFontSize', 120); num('#oStroke', 4); num('#oSpacing', 6);
    $('#oBold').click();
    $('#oFont').click(); await sleep(1200);
    const menu = $('#fontMenu');
    out.fontMenuItems = menu ? menu.querySelectorAll('.fm-item').length : 0;
    out.fontMenuHasImpact = menu ? [...menu.querySelectorAll('.fm-item')].some((x) => x.textContent === 'Impact') : false;
    out.localFontsApi = typeof window.queryLocalFonts;
    if (menu) { const it = [...menu.querySelectorAll('.fm-item')].find((x) => x.textContent === 'Impact'); if (it) it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); }
    out.fontAfterPick = cs.TXT.family;
    $('#oTextApply').click();
    const t1 = P.doc.layers[P.doc.active];
    out.layerAdded = P.doc.layers.length - n0; out.layerName = t1.name; out.textPixels = opaque(t1); out.live = !!t1.text; out.sessionClosed = !S.text;
    out.metaOk = !!t1.text && t1.text.text === 'Hello' && t1.text.family === 'Impact' && t1.text.size === 120 && t1.text.stroke === 4 && t1.text.spacing === 6 && t1.text.bold === true;
    const box1 = bbox(t1);

    // 2. click the text again: it reopens with the same settings; retype, mirror, turn, shadow; place
    const hit = cs.textHit(300 + 40, 300 + 40);
    out.hit = hit === P.doc.active;
    cs.setTool('brush'); cs.setTool('text');
    out.edit = cs.textEditLayer(hit);
    out.reopenedText = S.text && S.text.ta.value; out.reopenedFont = cs.TXT.family; out.reopenedSize = cs.TXT.size;
    out.hiddenWhileEditing = P.doc.layers[hit].editing === true;
    type('Hello again'); $('#oFlipH').click(); num('#oAngle', 20); $('#oShadow').click(); $('#oUnder').click();
    $('#oTextApply').click();
    const t2 = P.doc.layers[hit];
    out.editedSameLayer = P.doc.layers.length - n0 === 1 && P.doc.layers[hit] === t1;
    out.editedName = t2.name; out.editedMeta = !!t2.text && t2.text.text === 'Hello again' && t2.text.flipH === true && t2.text.rot === 20 && t2.text.shadow === true && t2.text.underline === true;
    out.editingFlagCleared = t2.editing === false;
    const box2 = bbox(t2);
    out.pixelsChanged = JSON.stringify(box1) !== JSON.stringify(box2);

    // 3. Undo goes back to the earlier text, Redo forward again
    P.undo(); out.undoText = P.doc.layers[hit].text && P.doc.layers[hit].text.text; out.undoFlip = P.doc.layers[hit].text && P.doc.layers[hit].text.flipH;
    P.redo(); out.redoText = P.doc.layers[hit].text && P.doc.layers[hit].text.text;

    // 4. Esc while editing throws the changes away and brings the layer back
    cs.textEditLayer(hit); type('discard me');
    $('#textBox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    out.escKeptOld = !S.text && P.doc.layers[hit].text.text === 'Hello again' && P.doc.layers[hit].editing === false;

    // 5. the Layers buttons: duplicate keeps the text editable, up / down, lock, merge, rename tile, delete
    $('#lDup').click();
    out.dupLive = !!P.doc.layers[P.doc.active].text && P.doc.layers.length - n0 === 2;
    out.upOffAtTop = $('#lUp').disabled;
    $('#lDown').click(); out.downMoved = P.doc.active === 1 + 0 || P.doc.active >= 1;
    $('#lLock').click(); out.lockTile = $('#lLock span').textContent; out.lockedNow = P.doc.layers[P.doc.active].locked;
    $('#lDel').click(); out.lockedDeleteRefused = P.doc.layers.length - n0 === 2;
    $('#lLock').click();
    out.tileLabels = [...document.querySelectorAll('.ltool span')].map((s) => s.textContent).join(',');
    const before = P.doc.layers.length;
    $('#lMerge').click();
    out.mergedOne = P.doc.layers.length === before - 1;
    $('#lDel').click();                                   // delete the (merged) text layer: one layer fewer
    out.deleted = P.doc.layers.length === before - 2;
    P.undo(); P.undo();                                   // bring it back (delete, then merge)
    out.undoBack = P.doc.layers.length === before;

    // 6. clearing all the text of an edit removes the layer; Undo brings it back with its text
    const idx = P.doc.layers.findIndex((l) => l.text && l.text.text === 'Hello again');
    const cnt = P.doc.layers.length;
    cs.textEditLayer(idx); type(''); $('#oTextApply').click();
    out.emptyRemoves = P.doc.layers.length === cnt - 1;
    P.undo(); out.emptyUndo = P.doc.layers.length === cnt && P.doc.layers.some((l) => l.text && l.text.text === 'Hello again');

    // 7. THE REPORTED CASE: place text, paint over it with the brush, then edit the text. Painting goes on its own layer; the text stays live.
    const maskOf = (L) => { const d = L.ctx.getImageData(0, 0, L.canvas.width, L.canvas.height).data, m = new Uint8Array(d.length / 4); for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 128 ? 1 : 0; return m; };
    const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++; } return u ? i / u : 1; };
    cs.setTool('text'); cs.textBegin(200, 1500); type('Keep me'); $('#oTextApply').click();
    const tL = P.doc.layers[P.doc.active], tIdx = P.doc.active, nA = P.doc.layers.length, textPx = opaque(tL);
    cs.setTool('brush'); P.opts.size = 24; P.opts.opacity = 1;
    P.down({ x: 260, y: 1560, pressure: 1 }, {}); P.move({ x: 360, y: 1560, pressure: 1 }, {}); P.up({ x: 360, y: 1560 }, {});
    const paintL = P.doc.layers[P.doc.active];
    out.paintMadeLayer = P.doc.layers.length === nA + 1 && paintL.name === 'Paint over text' && P.doc.layers.indexOf(paintL) === tIdx + 1;
    out.textStillLive = !!tL.text && P.doc.layers.indexOf(tL) === tIdx && opaque(tL) === textPx;
    out.marksOnOwnLayer = opaque(paintL) > 0;
    P.layerOp.select(tIdx);                                                    // back on the text layer, paint again: the same layer is reused
    P.down({ x: 260, y: 1600, pressure: 1 }, {}); P.move({ x: 360, y: 1600, pressure: 1 }, {}); P.up({ x: 360, y: 1600 }, {});
    out.reusedPaintLayer = P.doc.layers.length === nA + 1 && P.doc.layers[P.doc.active] === paintL;
    P.undo(); out.undoStroke2 = P.doc.layers.length === nA + 1;               // second stroke alone
    P.undo(); out.undoStroke1 = P.doc.layers.length === nA;                   // first stroke and its layer in ONE step
    P.redo(); P.redo(); out.redoBoth = P.doc.layers.length === nA + 1;
    cs.setTool('text');
    const hit7 = cs.textHit(215, 1515);
    out.hitAfterPaint = hit7 >= 0 && P.doc.layers[hit7] === tL;
    cs.textEditLayer(hit7); type('Edited after painting'); $('#oTextApply').click();
    out.editedAfterPaint = P.doc.layers.length === nA + 1 && tL.text && tL.text.text === 'Edited after painting' && opaque(paintL) > 0;

    // 7b. Move tool (drag and wheel) and the Resize tool keep the text live
    cs.setTool('move'); P.layerOp.select(P.doc.layers.indexOf(tL));
    const m0 = Object.assign({}, tL.text);
    P.down({ x: 300, y: 1520, pressure: 1 }, {}); P.move({ x: 340, y: 1550, pressure: 1 }, {}); P.up({ x: 340, y: 1550 }, {});
    out.moveLive = !!tL.text && tL.text.x === m0.x + 40 && tL.text.y === m0.y + 30;
    P.undo(); out.moveUndo = !!tL.text && tL.text.x === m0.x; P.redo();
    P.scaleActive(1.5, 400, 1600);
    out.wheelLive = !!tL.text && Math.abs(tL.text.size - m0.size * 1.5) < 0.05;
    P.undo();
    cs.setTool('transform');
    const st = P.xformState();
    P.xformSet({ sx: 1.4, sy: 1.4, rot: 0.3, fx: -1, cx: st.cx + 50, cy: st.cy - 20 }, true);
    const previewMask = maskOf(tL);
    P.xformEnd(true);
    // 1.4 times bigger, turned 0.3 rad (17.19 deg), mirrored left-right: on top of what the text already had (its own mirror and angle)
    out.resizeLive = !!tL.text && tL.text.flipH === !m0.flipH && Math.abs(tL.text.rot - (17.1887 - m0.rot)) < 0.05 && Math.abs(tL.text.size - m0.size * 1.4) < 0.05;
    const centre = (m, w) => { let n = 0, sx = 0, sy = 0; for (let k = 0; k < m.length; k++) if (m[k]) { n++; sx += k % w; sy += (k / w) | 0; } return [sx / n, sy / n]; };
    const c1 = centre(previewMask, tL.canvas.width), c2 = centre(maskOf(tL), tL.canvas.width);
    out.resizeSamePlace = Math.hypot(c1[0] - c2[0], c1[1] - c2[1]) < 3;           // the re-painted text sits where the dragged preview was
    out.resizeMatchesPreview = iou(previewMask, maskOf(tL)) > 0.85;
    out.resizeIoU = Math.round(iou(previewMask, maskOf(tL)) * 1000) / 1000;
    cs.setTool('transform'); P.xformSet({ sx: 2, sy: 1 }, true); P.xformEnd(true);
    out.stretchBakes = tL.text === null;
    P.undo(); out.stretchUndo = !!tL.text;
    cs.setTool('eraser'); P.opts.size = 30;
    P.down({ x: 300, y: 1560, pressure: 1 }, {}); P.up({ x: 300, y: 1560 }, {});
    out.eraserBakes = tL.text === null;
    P.undo(); out.eraserUndo = !!tL.text;
    P.layerOp.select(P.doc.layers.indexOf(paintL)); P.layerOp.mergeDown();   // merging paint into the text layer below makes that layer plain pixels
    out.mergeBakes = tL.text === null;
    P.undo(); out.mergeUndo = P.doc.layers.some((l) => l.text && l.text.text === 'Edited after painting');   // undo of a merge restores copies of the layers
    cs.setTool('brush');

    // 8. the project file keeps live text
    const ser = P.serialize(); const doc2 = await P.deserialize(ser, P.doc.w, P.doc.h);
    out.projectKeepsText = doc2.layers.filter((l) => l.text).length === P.doc.layers.filter((l) => l.text).length && doc2.layers.some((l) => l.text && l.text.text === 'Hello again');

    // 9. a second text, placed by clicking elsewhere, and a tool switch that places the open one
    cs.setTool('text'); cs.textBegin(300, 1100); type('tool switch'); cs.setTool('brush');
    out.toolSwitchPlaced = !S.text && P.doc.layers.some((l) => l.text && l.text.text === 'tool switch');

    // 10. everything shows up in the flattened texture the 3D view and Save use
    const flat = P.flatRGBA(); let red = 0; for (let i = 0; i < flat.length; i += 4) if (flat[i] > 200 && flat[i + 1] < 90 && flat[i + 2] < 90) red++;
    out.redPixelsInFlat = red;
    out.layers = names();
    return JSON.stringify(out);
  })()`;
}

// Headless self-test used while developing: CS_SMOKE_PACK=<folder> CS_SMOKE_OUT=<png>
// loads the pack, paints a stroke, writes it to the (copied!) YTD through the real
// IPC path, re-reads it, saves a screenshot and exits.
function smokeTest() {
  win.webContents.once('did-finish-load', async () => {
    const out = process.env.CS_SMOKE_OUT;
    try {
      const js = `(async () => {
        const p = await window.api.scanPack(${JSON.stringify(process.env.CS_SMOKE_PACK)});
        await window.__cs.loadPack(p);
        const P = window.__cs.Paint; window.__cs.setColor('#1971c2'); P.opts.size = 170;
        P.down({ x: 300, y: 900, pressure: 1 }, {}); P.move({ x: 900, y: 900, pressure: 1 }, {}); P.up({ x: 900, y: 900 }, {});
        const e = window.__cs.S.sel, rgba = P.flatRGBA();
        const res = await window.api.saveTexture(e.ytd, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
        const back = await window.api.loadTexture(e.ytd);
        const i = (900 * back.width + 600) * 4;
        const S = window.__cs.S;
        // new texture variant: copies the file to the next letter, then the pack is scanned again
        const used = e.item.variants.map((v) => v.letter);
        const bYtd = e.item.variants.find((v) => v.letter === 'b').ytd;
        const added = await window.api.addVariant(bYtd, used);            // c = copy of b
        const again = await window.api.scanPack(${JSON.stringify(process.env.CS_SMOKE_PACK)});
        const variants = { before: used, added: added.file, after: again.items.find((i) => i.id === e.item.id).variants.map((v) => v.letter) };
        // delete the MIDDLE texture of a,b,c,d: d must take c's place; then delete down to one and check the refusal
        const fp = (t) => { let h = 0; for (let i = 0; i < t.rgba.length; i += 997) h = (h * 31 + t.rgba[i]) >>> 0; return h; };
        const letters = async () => (await window.api.scanPack(${JSON.stringify(process.env.CS_SMOKE_PACK)})).items.find((i) => i.id === e.item.id).variants.map((v) => v.letter);
        const dAdded = await window.api.addVariant(e.ytd, used.concat('c'));   // d = copy of a (the painted one)
        const fpA = fp(await window.api.loadTexture(e.ytd)), fpB = fp(await window.api.loadTexture(bYtd));
        const fpC0 = fp(await window.api.loadTexture(added.file)), fpD0 = fp(await window.api.loadTexture(dAdded.file));
        variants.lettersAbcd = await letters();
        // the .ymt: hat 000 has 4 files (a,b,c,d) but the .ymt still lists 2 -> sync that one piece, then re-check
        const PK = ${JSON.stringify(process.env.CS_SMOKE_PACK)};
        const dl = (s) => s.genders.map((g) => g.diffs.map((d) => d.label + ' ' + d.have + '->' + d.want).join());
        variants.ymtBefore = dl(await window.api.ymtStatus(PK));
        variants.ymtSync = (await window.api.ymtSync(PK, { gender: 'male', only: e.item.id })).results.map((r) => [r.file, (r.changes || []).map((c) => c.label + ' ' + c.from + '->' + c.to).join(), r.backup, r.error || null]);
        variants.ymtAfter = dl(await window.api.ymtStatus(PK));
        const del = await window.api.deleteVariant(added.file);                // delete c
        variants.renames = del.renames.map((r) => [r.from.split(/[\\/]/).pop().slice(-18), r.to.split(/[\\/]/).pop().slice(-18), r.letter]);
        variants.trashed = del.trashed.length;
        variants.lettersAfterDeleteC = await letters();
        variants.newCIsOldD = fp(await window.api.loadTexture(added.file)) === fpD0 && fpD0 === fpA && fpC0 === fpB && fpA !== fpB;
        let dGone = false; try { await window.api.loadTexture(dAdded.file); } catch { dGone = true; }
        variants.dFileGone = dGone;
        await window.api.deleteVariant(added.file);                            // last one (c) -> a,b
        await window.api.deleteVariant(bYtd);                                  // -> a only
        let refused = null; try { await window.api.deleteVariant(e.ytd); } catch (err) { refused = String(err.message || err); }
        variants.onlyOneRefused = refused;
        variants.finalLetters = await letters();
        variants.ymtAfterDeletes = dl(await window.api.ymtStatus(PK));                     // files are back to a only -> the .ymt says 4
        variants.ymtSync2 = (await window.api.ymtSync(PK, {})).results.map((r) => [r.file, (r.changes || []).map((c) => c.label + ' ' + c.from + '->' + c.to).join(), r.error || null]);
        variants.ymtFinal = dl(await window.api.ymtStatus(PK));
        return JSON.stringify({ variants, file: e.ytd, res, painted: Array.from(back.rgba.slice(i, i + 4)), size: [back.width, back.height],
          body: { gta: S.gta, on: S.bodyOn, loaded: Object.keys(S.body), parts: S.body.male ? S.body.male.parts.map((p) => p.comp) : null, headBone: S.body.male && S.body.male.bones.head } });
      })()`;
      // the self-tests change tool settings: keep them out of the real profile (and clear what earlier runs may have left there)
      await win.webContents.executeJavaScript(`window.__noPrefs = true; try { localStorage.removeItem('cs.text2'); localStorage.removeItem('cs.text'); } catch { /* ignore */ } 0`);
      if (process.env.CS_SMOKE_MODE === 'shots') { await runShots(path.dirname(out)); app.exit(0); return; }
      const result = await win.webContents.executeJavaScript(process.env.CS_SMOKE_MODE === 'ops' ? opsSmokeJs() : process.env.CS_SMOKE_MODE === 'text' ? textSmokeJs() : js);
      await new Promise((r) => setTimeout(r, 1500));
      fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
      fs.writeFileSync(out + '.json', result);
      if (process.env.CS_SMOKE_POP) { // also open the 3D pop-out and capture it
        await win.webContents.executeJavaScript('window.api.viewerOpen()');
        await new Promise((r) => setTimeout(r, 5000));
        if (pop && !pop.isDestroyed()) {
          fs.writeFileSync(out + '.pop.png', (await pop.webContents.capturePage()).toPNG());
          // the smoke test painted a blue stroke at document (600, 900); the pop-out texture is 1024 px wide, so look at (307, 461)
          const sample = await pop.webContents.executeJavaScript('(() => { const t = window.__pop.tex(); if (!t) return null; return [...t.getContext("2d").getImageData(307, 461, 1, 1).data, t.width, t.height]; })()');
          fs.writeFileSync(out + '.pop.json', JSON.stringify({ bounds: pop.getBounds(), title: pop.getTitle(), displays: screen.getAllDisplays().length, texSample: sample }));
        } else fs.writeFileSync(out + '.pop.json', 'pop-out window did not open');
      }
    } catch (e) {
      fs.writeFileSync(out + '.json', 'ERROR ' + (e.stack || e));
    }
    app.exit(0);
  });
}

app.whenReady().then(() => {
  createWindow();
  // developer self-test hooks: they edit the pack they are pointed at, so they need an explicit extra opt-in
  if (process.env.CS_SMOKE_OUT && process.env.CS_SMOKE_PACK && process.env.CS_SMOKE_ALLOW === 'yes') { register(process.env.CS_SMOKE_PACK); smokeTest(); }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
