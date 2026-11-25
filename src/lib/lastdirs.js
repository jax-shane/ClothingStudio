'use strict';
// Each kind of file dialog opens in the folder it was last used in. main.js keeps the choices in settings.json as
// `lastDirs`; this file is the logic, with no Electron in it, so it can be tested.
//
//   import   images, textures and .ydd models brought in from anywhere (for example your Downloads folder)
//   pack     the folder your clothing packs live in (Open pack, New pack)
//   build    where Build writes the FiveM resource
//   project  layered .csproj files
//   export   exported PNG files

const fs = require('fs');
const path = require('path');

const savedDirs = (s) => (s && s.lastDirs && typeof s.lastDirs === 'object' && !Array.isArray(s.lastDirs) ? s.lastDirs : {});

/** read() returns the settings object, write(settings) stores it. */
function lastDirs({ read, write }) {
  /** The remembered folder of a kind, or null (nothing remembered yet, or the folder is gone: the OS chooses then). */
  function lastDir(kind) {
    const d = savedDirs(read())[kind];
    try { if (typeof d === 'string' && fs.statSync(d).isDirectory()) return d; } catch { /* the folder is gone */ }
    return null;
  }

  function rememberDir(kind, dir) {
    if (typeof dir !== 'string' || !dir) return;
    const s = read(), dirs = savedDirs(s);
    if (dirs[kind] !== dir) write({ ...s, lastDirs: { ...dirs, [kind]: dir } });
  }

  /** Dialog options that start in the remembered folder. A save dialog also passes the suggested file name. */
  function startIn(kind, fileName) {
    const d = lastDir(kind);
    if (d) return { defaultPath: fileName ? path.join(d, fileName) : d };
    return fileName ? { defaultPath: fileName } : {};
  }

  return { lastDir, rememberDir, startIn };
}

module.exports = { lastDirs };
