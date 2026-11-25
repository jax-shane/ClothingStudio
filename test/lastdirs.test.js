'use strict';
// Covers src/lib/lastdirs.js - file dialogs reopening in the folder they were last used in. Real temporary folders,
// settings kept in memory (main.js keeps them in settings.json).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lastDirs } = require('../src/lib/lastdirs');
const { tempDir, cleanup } = require('./helpers');

after(cleanup);

/** lastDirs over an in-memory settings object; `state.writes` counts how often the settings were stored */
function make(initial = {}) {
  const state = { settings: initial, writes: 0 };
  const api = lastDirs({ read: () => state.settings, write: (s) => { state.settings = s; state.writes++; } });
  return { state, ...api };
}

describe('remembered folders for file dialogs', () => {
  it('with nothing remembered the dialogs behave as before', () => {
    const t = make();
    assert.deepEqual(t.startIn('import'), {});
    assert.deepEqual(t.startIn('export', 'a.png'), { defaultPath: 'a.png' });
    assert.equal(t.lastDir('import'), null);
  });

  it('a dialog reopens in the folder it was last used in; each kind of dialog has its own folder', () => {
    const downloads = tempDir('cs_dl'), exports = tempDir('cs_exp');
    const t = make({ gtaDir: 'D:\\GTA' });
    t.rememberDir('import', downloads);
    assert.deepEqual(t.startIn('import'), { defaultPath: downloads });
    assert.deepEqual(t.startIn('export', 'a.png'), { defaultPath: 'a.png' }, 'importing did not move the export dialog');
    t.rememberDir('export', exports);
    assert.deepEqual(t.startIn('export', 'a.png'), { defaultPath: path.join(exports, 'a.png') }, 'a save dialog keeps its suggested file name');
    assert.deepEqual(t.startIn('import'), { defaultPath: downloads }, 'and exporting did not move the import dialog');
    assert.equal(t.state.settings.gtaDir, 'D:\\GTA', 'the other settings are kept');
    assert.deepEqual(t.state.settings.lastDirs, { import: downloads, export: exports });
  });

  it('remembering the same folder again does not rewrite the settings', () => {
    const d = tempDir('cs_dl');
    const t = make();
    t.rememberDir('pack', d);
    const writes = t.state.writes;
    t.rememberDir('pack', d);
    assert.equal(t.state.writes, writes);
  });

  it('a folder that no longer exists (or is really a file) is ignored', () => {
    const d = tempDir('cs_dl'), file = path.join(tempDir('cs_f'), 'x.txt');
    fs.writeFileSync(file, 'x');
    const t = make({ lastDirs: { import: d, build: file } });
    assert.equal(t.lastDir('import'), d);
    assert.equal(t.lastDir('build'), null, 'a file is not a folder');
    fs.rmSync(d, { recursive: true, force: true });
    assert.deepEqual(t.startIn('import'), {}, 'the Windows default is used again');
  });

  it('hand-edited or damaged settings never throw, and remembering repairs them', () => {
    const d = tempDir('cs_dl');
    for (const bad of [null, [], 'oops', 5, { lastDirs: 'x' }, { lastDirs: null }, { lastDirs: 5 }, { lastDirs: [] }, { lastDirs: { import: 7 } }]) {
      const t = make(bad);
      assert.doesNotThrow(() => { t.startIn('import'); t.rememberDir('import', d); }, JSON.stringify(bad));
      assert.deepEqual(t.startIn('import'), { defaultPath: d }, JSON.stringify(bad));
    }
  });

  it('things that are not a folder name are ignored', () => {
    const t = make();
    for (const junk of [undefined, null, '', 42, {}, ['x']]) t.rememberDir('import', junk);
    assert.equal(t.state.writes, 0);
  });
});
