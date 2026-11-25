'use strict';
// Single-player build: turns the clean FiveM resource that Build writes into a DLC pack for single-player GTA V
// (<GTA V>\mods\update\x64\dlcpacks\<name>\dlc.rpf, plus one line in dlclist.xml).
//
// The layout is the one of the game's own clothing DLCs (read from a real install while this was written):
//   dlc.rpf
//     content.xml, setup2.xml                        what the pack is and what to enable
//     common/data/mp_m_freemode_01_<name>.meta       the shop metadata (the same file a FiveM resource has)
//     x64/anim/creaturemetadata.rpf                  heels / hair scale data, only when something uses it
//     x64/models/cdimages/<name>_male.rpf            mp_m_freemode_01_<name>.ymt + folder mp_m_freemode_01_<name>/ with the .ydd / .ytd
//     x64/models/cdimages/<name>_male_p.rpf          the props: folder mp_m_freemode_01_p_<name>/
//     (and the same for _female)
// A FiveM stream file is called <dictionary>^<file>; in an archive the dictionary is the folder and the file keeps the part after the ^.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeRpf } = require('./rpfwrite');
const { scanPack, walk } = require('./pack');
const packops = require('./packops');

const ORDER = 57;                                          // setup2.xml <order>: the game's own packs use 0 - 57, and several share a number
const SIDE = { m: 'male', f: 'female' };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

function contentXml(name, registered) {
  const dev = `dlc_${name}`;
  const file = (r) => `${dev}:/${r.file}`;
  const items = registered.map((r) => `    <Item>
      <filename>${file(r)}</filename>
      <fileType>${r.type}</fileType>
      <overlay value="false" />
      <disabled value="true" />
      <persistent value="${r.type === 'RPF_FILE' ? 'true' : 'false'}" />
    </Item>`).join('\n');
  const enable = registered.map((r) => `        <Item>${file(r)}</Item>`).join('\n');
  return crlf(`<?xml version="1.0" encoding="UTF-8"?>
<CDataFileMgr__ContentsOfDataFileXml>
  <disabledFiles />
  <includedXmlFiles />
  <includedDataFiles />
  <dataFiles>
${items}
  </dataFiles>
  <contentChangeSets>
    <Item>
      <changeSetName>${name.toUpperCase()}_AUTOGEN</changeSetName>
      <mapChangeSetData />
      <filesToInvalidate />
      <filesToDisable />
      <filesToEnable>
${enable}
      </filesToEnable>
      <txdToLoad />
      <txdToUnload />
      <residentResources />
      <unregisterResources />
      <requiresLoadingScreen value="false" />
    </Item>
  </contentChangeSets>
  <patchFiles />
</CDataFileMgr__ContentsOfDataFileXml>
`);
}

function setupXml(name, when) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${p(when.getDate())}/${p(when.getMonth() + 1)}/${when.getFullYear()} ${p(when.getHours())}:${p(when.getMinutes())}:${p(when.getSeconds())}`;
  return crlf(`<?xml version="1.0" encoding="UTF-8"?>
<SSetupData>
  <deviceName>dlc_${name}</deviceName>
  <datFile>content.xml</datFile>
  <timeStamp>${stamp}</timeStamp>
  <nameHash>${name}</nameHash>
  <contentChangeSets />
  <contentChangeSetGroups>
    <Item>
      <NameHash>GROUP_STARTUP</NameHash>
      <ContentChangeSets>
        <Item>${name.toUpperCase()}_AUTOGEN</Item>
      </ContentChangeSets>
    </Item>
  </contentChangeSetGroups>
  <startupScript />
  <scriptCallstackSize value="0" />
  <type>EXTRACONTENT_COMPAT_PACK</type>
  <order value="${ORDER}" />
  <minorOrder value="0" />
  <isLevelPack value="false" />
  <dependencyPackHash />
  <requiredVersion />
  <subPackCount value="0" />
</SSetupData>
`);
}

const dlclistLine = (name) => `<Item>dlcpacks:/${name}/</Item>`;

function installText(name) {
  return crlf(`ClothingStudio - single-player DLC pack "${name}"
=====================================================

This folder holds dlc.rpf, your clothing as a DLC pack for single-player GTA V.

1. Copy THIS FOLDER (the one called "${name}", with dlc.rpf in it) into
       <your GTA V folder>\\mods\\update\\x64\\dlcpacks\\
   Create the folders that do not exist yet. This assumes OpenIV's "mods" folder is set up.

2. Tell the game about the pack. In OpenIV open update\\update.rpf\\common\\data\\dlclist.xml, copy it to
       <your GTA V folder>\\mods\\update\\update.rpf\\common\\data\\
   (OpenIV does this when you edit the file in the mods folder), and add this line after the last <Item> line, before </Paths>:

       ${dlclistLine(name)}

3. Start the game. The clothes belong to the multiplayer freemode characters (mp_m_freemode_01 and mp_f_freemode_01),
   so you need a trainer / menu mod that can switch the player to a freemode character and change its clothes.

Notes
- Written by ClothingStudio. The layout follows the game's own clothing DLCs and the archive was read back and checked, but it has
  not been tried in game: keep a backup of your game files and of dlclist.xml.
- To change the pack, open the original pack folder in ClothingStudio, make the change and build again (the name stays the same).
`);
}

/**
 * The files of a clean FiveM resource (the output of buildResource) as the contents of a single-player dlc.rpf.
 * Returns { rpf: Buffer, archives: [{ name, files }], notes: [] }.
 */
function convertResource(dir, name) {
  const notes = [];
  const arch = new Map();                                   // archive name -> [{ path, data }]
  const put = (archive, p, data) => { if (!arch.has(archive)) arch.set(archive, []); arch.get(archive).push({ path: p, data }); };
  const registered = [];                                    // what content.xml registers: { file, type }
  const dlcFiles = [];

  const pedYmt = new RegExp(`^mp_([mf])_freemode_01_${esc(name)}\\.ymt$`, 'i');
  const creatureYmt = new RegExp(`^mp_creaturemetadata_([mf])_${esc(name)}\\.ymt$`, 'i');
  const creatures = [];
  for (const f of walk(path.join(dir, 'stream'))) {
    const n = path.basename(f);
    let m;
    if ((m = pedYmt.exec(n))) { put(`${name}_${SIDE[m[1].toLowerCase()]}.rpf`, n, fs.readFileSync(f)); continue; }
    if ((m = creatureYmt.exec(n))) { creatures.push({ path: n, data: fs.readFileSync(f) }); continue; }
    const caret = n.indexOf('^');
    const d = caret > 0 && /^mp_([mf])_freemode_01(_p)?_(.+)$/i.exec(n.slice(0, caret));
    if (!d) { notes.push(`${n} was left out: it is not a clothing file this builder knows how to place`); continue; }
    put(`${name}_${SIDE[d[1].toLowerCase()]}${d[2] ? '_p' : ''}.rpf`, `${n.slice(0, caret)}/${n.slice(caret + 1)}`, fs.readFileSync(f));
  }

  // metadata at the root of the resource
  const metas = [];
  for (const n of fs.readdirSync(dir).sort()) {
    if (!fs.statSync(path.join(dir, n)).isFile()) continue;
    const l = n.toLowerCase();
    let at = null, type = null;
    if (/^mp_[mf]_freemode_01_.+\.meta$/.test(l)) { at = 'common/data/' + n; type = 'SHOP_PED_APPAREL_META_FILE'; }
    else if (/^first_person_alternates_.*\.meta$/.test(l)) { at = 'common/data/effects/peds/' + n; type = 'PED_FIRST_PERSON_ALTERNATE_DATA'; notes.push(`${n} is registered like the shop metadata; that was not verified for single player`); }
    else if (/^pedalternativevariations_.*\.meta$/.test(l)) { at = 'common/data/' + n; type = 'ALTERNATE_VARIATIONS_FILE'; notes.push(`${n} is registered like the shop metadata; that was not verified for single player`); }
    if (at) { metas.push({ path: at, data: fs.readFileSync(path.join(dir, n)) }); registered.push({ file: at, type }); }
  }
  dlcFiles.push(...metas);

  if (creatures.length) {
    dlcFiles.push({ path: 'x64/anim/creaturemetadata.rpf', data: writeRpf(creatures) });
    registered.push({ file: '%PLATFORM%/anim/creaturemetadata.rpf', type: 'RPF_FILE' });
    notes.push('Heels / hair scale data is in creaturemetadata.rpf under the same names the shop metadata asks for; that was not verified for single player');
  }

  const archives = [];
  for (const [archive, files] of [...arch.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    dlcFiles.push({ path: `x64/models/cdimages/${archive}`, data: writeRpf(files) });
    registered.push({ file: `%PLATFORM%/models/cdimages/${archive}`, type: 'RPF_FILE' });
    archives.push({ name: archive, files: files.length });
  }
  if (!archives.length) throw new Error('There is nothing to build: the pack has no pieces.');

  dlcFiles.push({ path: 'content.xml', data: Buffer.from(contentXml(name, registered), 'utf8') });
  dlcFiles.push({ path: 'setup2.xml', data: Buffer.from(setupXml(name, new Date()), 'utf8') });
  return { rpf: writeRpf(dlcFiles), archives, notes };
}

/**
 * Build the pack `root` as a single-player DLC pack in outDir (which must be empty or new): dlc.rpf and INSTALL.txt.
 * The name is lower-cased (the game's folder name and the dlclist.xml line). Nothing is left behind when it fails.
 */
function buildSinglePlayer(root, outDir, newName) {
  const pack = scanPack(root);
  const name = String(newName || pack.dlcName || '').toLowerCase();
  if (!packops.validName(name)) throw new Error('Use letters, digits and underscores only for the name (up to 40 characters).');
  if (!pack.items.length) throw new Error('There is nothing to build: the pack has no pieces.');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error('The output folder is not empty: ' + outDir);
  const outRoot = path.resolve(outDir).toLowerCase(), inRoot = path.resolve(root).toLowerCase();
  if (outRoot === inRoot || outRoot.startsWith(inRoot + path.sep)) throw new Error('Choose a folder outside the pack you are building from.');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs_sp_'));
  const work = outDir + '.cs_building';
  try {
    const res = packops.buildResource(root, path.join(tmp, 'res'), name);
    const conv = convertResource(path.join(tmp, 'res'), name);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'dlc.rpf'), conv.rpf);
    fs.writeFileSync(path.join(work, 'INSTALL.txt'), installText(name), 'utf8');
    if (fs.existsSync(outDir)) fs.rmdirSync(outDir);
    fs.renameSync(work, outDir);
    return { root: outDir, name, target: 'singleplayer', files: res.files, archives: conv.archives, notes: [...res.notes, ...conv.notes], dlclist: dlclistLine(name), bytes: conv.rpf.length };
  } catch (e) {
    fs.rmSync(work, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { buildSinglePlayer, convertResource, contentXml, setupXml, installText, dlclistLine };
