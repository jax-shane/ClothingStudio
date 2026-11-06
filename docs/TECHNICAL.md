# Technical notes

How ClothingStudio works inside. Written for people who want to fix a bug, add a feature, or just trust what the app does to their files.

**Contents:** [Overview](#overview) · [Source map](#source-map) · [File formats](#file-formats) · [Safety design](#safety-design) ·
[The paint engine](#the-paint-engine) · [Live text](#live-text) · [The 3D view](#the-3d-view-1) · [Tests](#tests) ·
[Running, building, packaging](#running-building-packaging) · [Developer hooks](#developer-hooks) · [Limits](#limits-and-ideas)

---

## Overview

ClothingStudio is an **Electron** app (Chromium + Node.js).

```
┌────────────────────────── renderer (browser side, no Node) ──────────────────────────┐
│  index.html · style.css · js/app.js (UI)  · js/paint.js (layers, tools, undo, text)  │
│  js/viewer.js (three.js)  · js/pieces.js (Add-piece & options dialogs) · js/api.js   │
└───────────────▲──────────────────────────────────────────────────────────────────────┘
                │  window.api.*  (preload.js, contextIsolation on, only named calls)
┌───────────────┴────────────────────── main process (Node) ───────────────────────────┐
│  main.js: windows, dialogs, Recycle Bin, IPC handlers ("one operation at a time")     │
│  src/lib/*: everything that touches game files (pure Node, no Electron)               │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

The rule: **all knowledge of file formats and all disk writes live in `src/lib`**, which never imports Electron, so it is fully
testable from plain Node (`npm test`). `main.js` only wires dialogs and IPC to those functions and passes the Recycle Bin in as a
`trash` callback. The renderer cannot read or write files itself; it can only call the functions exposed in `preload.js`.

## Source map

| Path | What it does |
|---|---|
| `main.js`, `preload.js` | Electron shell: window, file dialogs, IPC, pop-out window, developer smoke-test hooks |
| `src/lib/rsc.js` | RSC7 resource container: 16-byte header + raw-deflate; system / graphics segments and pointers |
| `src/lib/ytd.js` | Texture dictionary: read, decode (DXT1 / DXT5 / A8R8G8B8), mip chains, encode, **patch pixels back into the original file** |
| `src/lib/ydd.js` | Drawable dictionary reader: positions, normals, UVs, indices |
| `src/lib/ymt.js` + `ymt_types.json` | `CPedVariationInfo` ped-variation `.ymt` (a "Meta" resource): read, normalise, write byte-compatibly; insert / remove / move drawables; options |
| `src/lib/rbf.js` | RBF0 binary XML, used by the creature metadata file |
| `src/lib/creature.js` | creature metadata (hair scale, heels) generation rules |
| `src/lib/options.js` | audio / flag / render-flag lists of the Options dialog |
| `src/lib/pack.js` | scans a resource folder into gender → category → piece → texture letters |
| `src/lib/packops.js` | **pack operations**: add / move / delete pieces, add textures, piece options, new pack, build resource, journal, recovery |
| `src/lib/rpf.js`, `gtakeys.js`, `body.js`, `body-worker.js`, `skeleton.js` | the optional mannequin: reads the user's own GTA V archives |
| `renderer/js/paint.js` | the paint engine (layers, tools, undo, transforms, live text) |
| `renderer/js/app.js` | the UI: Pack list, layers panel, options bar, colour wheel, text editor, dialogs |
| `renderer/js/viewer.js` | three.js scene, orbit camera, live texture, mannequin, pop-out sync |
| `renderer/js/pieces.js` | the *Add pieces* and *Options* dialogs |
| `dev-server.js` | optional: serves the UI in a normal browser for testing (read-only unless started with `--allow-write`) |
| `test/` | the automated tests (`node:test`, no dependencies) |

## File formats

All of this is re-implemented in JavaScript from the layouts documented by [CodeWalker](https://github.com/dexyfex/CodeWalker); see
[NOTICE.md](../NOTICE.md).

- **RSC7**: `.ytd`, `.ydd`, `.ymt` and friends are "resources": a 16-byte header, then a raw-deflate stream. Inflated, the buffer is the
  system segment followed by the graphics segment; pointers use `0x5…` for the system and `0x6…` for the graphics segment.
- **YTD**: a dictionary of textures. ClothingStudio decodes the first mip to RGBA for painting. On save it **patches** the encoded
  pixels and mip chain back into the *original file's* structure (size, format and every header field untouched), then **re-reads and
  verifies** the result before it replaces the file. DXT1 is encoded with an alpha-aware block fitter (on/off transparency is
  verified); DXT5 keeps smooth alpha; A8R8G8B8 is lossless.
- **YMT (ped variation)**: a "Meta" resource: blocks per structure type; arrays are `(block id in the low 12 bits, offset << 12)` pointers.
  Root 0x70 bytes, component 0x18, drawable 0x30, texture 3, component-info 0x30, prop 0x38, prop texture 0xc, anchor 0x18. The writer
  reproduces the layout of grzyClothTool / CodeWalker files so that an **unchanged file comes out byte-for-byte identical** (header 0x90,
  structures from 0x1090, data blocks, the name last). Entries keep their order (the game looks up by slot + number); `ymt_types.json`
  holds the fixed structure tables so the output agrees with the format.
- **Creature metadata** (`mp_creaturemetadata_<m|f>_<dlc>.ymt`): RBF0, a binary XML: a descriptor-name table then typed nodes
  (`0x00` struct, `0x10` u32, `0x20/0x30` bool, `0x40` float, `0x50` float3, `0x60` string; `FD FF` / `FF FF` markers). Rules: any hat
  with hair scale ⇒ entries for all `p_head` pieces plus a dummy first one (`pedPropVarIndex = 0xFFFFFFFF`, ids `13201`); any heels ⇒
  entries for all feet (`pedCompID 6`, expression 4, ids `28462`); none ⇒ no file.
- **Options → fields.** Component info: audio `@0`, second audio `@4`, expression-modifier floats `@8` (heels = float 4 at `0x18`), flags
  `@0x1c`, component index `@0x2c`, drawable index `@0x2d`. Prop: audio `@0`, expression modifiers `@4` (float 0 = −hair scale), texture
  array `@0x18`, render flags `@0x28` (`PRF_ALPHA = 0`, `PRF_DECAL = 1`, `PRF_CUTOUT = 2`), prop flags `@0x2c`, anchor id `@0x32`, prop id `@0x33`.
  "Has skin" is bit 4 of the component's mask.

## Safety design

The promise is "no file is lost and no pack is left half changed". How:

| Mechanism | Where |
|---|---|
| **Plan first, write second.** Every operation computes the whole plan (including the new `.ymt` in memory) before touching a file | `packops.js` |
| **Journal.** Each rename / new file is appended to `<pack>/.cs_journal.json` as it happens. `recoverPack` replays it backwards at the next open (tests kill a child process mid-operation to prove it) | `packops.js` `Journal`, `recoverPack` |
| **No permanent deletes.** Removed files go through a `trash` callback. The app passes `shell.trashItem`, which keeps the real name in the Recycle Bin; a temporary backup is kept until the whole operation has succeeded | `packops.js`, `main.js` |
| **`.bak` once** for every `.ytd`, `.ymt` and creature file, never overwritten | `ytd.js`, `ymt.js`, `packops.js` |
| **Verify, then replace atomically.** A new `.ytd` is written to `<file>.tmp`, decoded again and compared with what was painted (a mean error over 40 aborts and leaves the old file untouched), then renamed over the original. A new `.ymt` is likewise built, re-read and compared before it replaces the old one | `ytd.js`, `ymt.js` |
| **One operation at a time** (`withOp` lock in `main.js`; the UI also blocks) | `main.js`, `app.js` |
| **No renderer file access.** File picks are registered in the main process and handed to the renderer as opaque tokens; dropped paths are checked for provenance; the pack must be the one that was opened | `main.js`, `preload.js` |
| **Unknown `.ymt` ⇒ hands off.** If the file does not match the known structure it is reported and left alone | `ymt.js` |

## The paint engine

`renderer/js/paint.js` is a small layered canvas editor.

- A **document** has a list of layers (each its own canvas with `visible`, `opacity`, `blend`, `locked`), the active index, an undo and a
  redo stack, and an optional guide image.
- **Undo** has two entry kinds: `px` (the pixels of one layer, plus that layer's live-text settings) and `st` (a snapshot of the whole layer
  list, for add / delete / merge / move). Snapshots are capped by a memory budget per document.
- Brush strokes are built on a separate stroke canvas and composited with the layer's opacity, so soft brushes do not stack unevenly.
- The **Resize** tool keeps the layer's original pixels and re-renders from them on every change, so scaling up and down never accumulates
  blur, and bakes the result as one undo step on Apply.
- The 3D texture is a down-scaled flatten of the visible layers, streamed to the viewer while you paint.

## Live text

A layer may carry `layer.text`, the description of the text it contains:

```js
{ text, family, size, bold, italic, underline, strike, caps, align,
  spacing, leading, rot, flipH, flipV,
  color, opacity, stroke, strokeColor,
  shadow, shadowColor, shadowBlur, shadowX, shadowY,
  x, y }                       // top-left of the block before it is rotated
```

- `Paint.textLayout(o)` measures a block (line widths, line height = size × leading, baseline) and is used by **both** the painter and the
  on-canvas editor, so what you type is what is painted.
- `Paint.drawText(ctx, o, x, y)` paints it, rotating and mirroring about the middle of the block, drawing the shadow once per line (from
  the outline if there is one, else from the fill).
- The editor is a transparent `<textarea>` placed over the canvas, set in the same font at the zoomed size and given the same rotate / mirror
  transform, with a live preview canvas underneath drawn by `drawText`. The layer being edited has `editing = true`, which the compositor skips.
- Committing calls `addTextLayer` (new) or `updateTextLayer` (existing; one `px` undo entry carrying the old settings). Any other pixel
  change goes through `pushPx()`, which clears `layer.text` (the layer becomes plain pixels), and undo restores it.
- Live text is saved in `.csproj` files and cloned by *Duplicate*.

## The 3D view

three.js. The `.ydd` is parsed in the main process (`ydd.js`) and sent to the renderer as typed arrays; the texture is a canvas the paint
engine flattens into. The optional **mannequin** is built from the user's own GTA V: `rpf.js` reads the archives, `gtakeys.js` finds the
archive keys inside `GTA5.exe` by hashing aligned windows against the SHA-1 digests in `key_hashes.json` (no key material is shipped), the
result is cached in `%APPDATA%\ClothingStudio\keys.bin`, and `body-worker.js` does the heavy work off the main thread. The pop-out window is
a second `BrowserWindow` that receives the mesh and a stream of texture frames over IPC.

## Tests

```bash
npm test
```

runs `node --test` (every file in `test/`): **100+ tests, a few seconds, no game files, no network, nothing outside the OS temp folder.** They build
packs from the blank texture template in `src/lib/assets/`, with stand-in `.ydd` files (pack operations never parse a model).

| File | Covers |
|---|---|
| `rbf-creature.test.js` | RBF round trip; the creature-metadata rules |
| `ymt.test.js` | model creation, insert / remove / move, options, write / read, byte-identical rebuild, compare / sync |
| `ytd.test.js` | reading the template, formats, patch round-trip, `.bak`, DXT1 alpha verification |
| `pack.test.js` | name parsing, scanning, empty new pack |
| `packops-pieces.test.js` | create pack, add / move / delete pieces and textures, options, skin renaming, rollback |
| `packops-recovery-build.test.js` | kills a child process mid-operation then checks recovery restores the pack byte for byte; **Build** output |

The renderer is checked by packaged-app smoke tests (below), not by `npm test`.

## Running, building, packaging

```bash
npm install
npm start               # run the app from source
npm run dev             # the UI in a browser at http://localhost:5173/renderer/index.html?pack=<folder> (read-only)
npm test
npm run package         # dist/ClothingStudio-win32-x64/ClothingStudio.exe (electron-packager, asar)
```

`--prune` keeps only the production dependencies (`three`); Electron's own runtime is added by the packager. The `dist/` folder is portable.

## Developer hooks

For self-tests of the packaged app, `main.js` has hooks that **edit the pack they are pointed at**, so they do nothing unless *all* of these
are set: `CS_SMOKE_OUT=<png path>`, `CS_SMOKE_PACK=<pack copy>`, `CS_SMOKE_ALLOW=yes`. `CS_SMOKE_MODE` selects `ops` (piece operations
through the real UI functions), `text` (the Text tool and the Layers buttons), or `shots` (screenshots for the documentation); with none it
paints, saves, re-reads and adds / deletes textures. `CS_SMOKE_POP=1` also opens and captures the 3D pop-out. **Always point them at a copy.**

## Limits and ideas

- Not handled: splitting packs of more than 128 pieces; *replace*, *singleplayer* and AltV layouts; editing `.meta` files; editing models.
- Textures keep their original size and format; changing them needs a new `.ytd` through *Add textures*.
- The mannequin needs the **legacy** GTA V edition (the Enhanced edition uses different keys).
- Ideas: curved (arc) text, gradient fills, a library of saved logos, drag-to-reorder pieces, a Mac / Linux build.

Pull requests are welcome, see [CONTRIBUTING](../CONTRIBUTING.md).
