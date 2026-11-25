# Changelog

All notable changes to ClothingStudio. The format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Keyboard shortcuts** for nearly everything, with **F1** (or **?**, or the new **⌨** button) showing them all: `Ctrl+O` open pack,
  `Ctrl+Shift+S` / `Ctrl+Shift+O` save / open layers, `Ctrl+Shift+E` export PNG, `Ctrl+I` import image, `Ctrl+B` build; `Page Down` /
  `Page Up` next / previous texture (on into the next piece), `Ctrl+Page Down` / `Ctrl+Page Up` next / previous piece, `Ctrl+D` copy the
  texture to other pieces, `Ctrl+Shift+D` new texture as a copy, `Ctrl+P` piece options; `Shift+[` / `Shift+]` brush hardness, `1` … `0`
  opacity, `D` black / white, `M` mirror painting; `Ctrl+Shift+N` new layer, `Alt+[` / `Alt+]` select the layer below / above, `Ctrl+,`
  show / hide, `Ctrl+/` lock, `F2` rename, `Del` delete the layer; `Ctrl+0` fit, `Ctrl+1` 100 %, `Ctrl` `+` / `-` zoom, `U` UV guide.
  The old ones stay. Keys are read so that other keyboard layouts work too (AltGr characters, the number keys by position on AZERTY).
- **Copy a texture to other pieces.** From the **⋯** menu of a piece (or `Ctrl+D`): pick the texture, tick the pieces (filter box, "Tick the
  same kind") and every ticked piece gets a copy as its next letter, with the `.ymt` following. The copy is the saved `.ytd` itself (same
  size, format and mips), or your unsaved painting if you choose it.
- **11 languages.** The whole interface (buttons, tooltips, questions, messages, the 3D pop-out window, the native file dialogs and the error
  messages of the main process) can be shown in English, Español, Português (Brasil), Français, Deutsch, Русский, Türkçe, Polski, Italiano,
  Nederlands and العربية. The program starts in the language of the PC (a regional variant falls back to its
  language, Portuguese to Brazilian Portuguese, Chinese by script, Norwegian Bokmål to `no`) and the **🌐** button at the top right changes it
  on the spot, nothing is lost; the choice is kept in `settings.json`. Texts with a number use each language's own plural rules, lists are written
  the way the language writes them, and Arabic and Hebrew set the words right to left (the layout is not mirrored). Pieces and categories are named
  in the language too (*Tops 000*). The translations were made with machine translation and are marked as such in the language dialog; a text
  that is not translated shows in English. Adding or fixing a language is a text file: `docs/TRANSLATING.md`, `renderer/lang/<code>.js`,
  `node tools/i18n.js check` (placeholders, plural forms, lengths), `node tools/i18n.js pseudo` (a test language for finding untranslated text
  and layouts that break). Messages from the file-format code in `src/lib` (the part after the colon in an error toast) stay English.
- **Single-player DLC packs.** **Build** now asks what to build for: a **FiveM resource** (as before) or a **Single player (dlc.rpf)** pack for
  story mode. The pack has the layout of the game's own clothing DLCs, read from an install: `content.xml` and `setup2.xml`, the shop
  metadata under `common/data`, the creature metadata archive when heels or hair scale are used, and `<name>_male/_female(_p).rpf` archives in
  `x64/models/cdimages` holding the `.ydd` / `.ytd` files and the ped `.ymt`; with an `INSTALL.txt` (copy the folder into
  `<GTA V>\mods\update\x64\dlcpacks\`, add `<Item>dlcpacks:/<name>/</Item>` to `dlclist.xml`). New `src/lib/rpfwrite.js` writes unencrypted
  RPF7 archives; it was checked against the game's own archives (about 2 500 files read, written again and read again: entries, resource flags
  and table order agree) and the pack is read back in the tests. **Not tried in game yet.**
- **Bigger textures.** An image that is bigger than the texture it is going into (in both directions) now asks, like Paint.NET's canvas
  question: **keep the texture's size** (the image is scaled down, the default) or **make the texture bigger**, 2× or 4× up to 4096×4096.
  It asks for **Import image…** (also a dropped or pasted image), for **Open layers…** on a project saved bigger, and for **Add textures…** /
  **Add piece…** (one question for all the images, "up to" a size when they differ). In the editor everything already painted is scaled up
  with the texture (live text is painted again, so it stays sharp and editable), the new image goes in at its own pixels, and Undo brings
  the old size back; the `.ytd` is rewritten at the new size when you press **Save to YTD**, which shows the old and the new size and
  keeps the original as `.bak`. Textures added through the Add flows are written at their size straight away. New `ytd.resizeTexture` builds
  the new file with the same page layout as the bundled template and reads it back before replacing anything; sizes are powers of two from
  4 to 4096. Checked by writing and re-reading files, not in game. A "do not ask again" tick keeps the texture size until the app restarts.
- **File dialogs remember their folder.** Import image, Add textures, Add models (`.ydd`), Open pack, New pack, Build, Export PNG and the
  layered-project Open / Save dialogs now open in the folder you last used them in, instead of starting from the same place every time.
  Images, textures and models share one remembered folder (so a Downloads folder full of textures stays one click away); packs, builds,
  exported PNGs and `.csproj` files each remember their own. A folder that no longer exists is ignored. Kept in `settings.json`.

### Changed
- The undo memory of a document is also capped at about 1 GB however many layers it has (a 4096×4096 document with many layers is big).
- Piece names in the list use proper singular names: *Pants 000*, *Shoes 000*, *Glasses 000* instead of *Pant 000*, *Shoe 000*, *Glasse 000*.
- The text layers' and layers' default names (*Layer 2*, *Original*, *Text: …*) are written in the language of the editor when they are made.
- The pop-out 3D window takes its language and title from the editor.

### Fixed
- Electron's hidden default menu still answered `Ctrl+R` (reload the window, throwing unsaved painting away) and `Ctrl+0` / `Ctrl+=` /
  `Ctrl+-` (zoom the whole window). The app has no application menu now, so those keys are the editor's own.

## [0.2.1] – 2026-11-07

### Fixed
- **Text stayed editable only until you touched its layer.** Painting on the selected text layer with the Brush, then trying to edit the text,
  did nothing, and so did moving or resizing it first. Now the Brush, Line, Rect and Oval paint on a layer of their own just above a text
  layer (a note tells you), and the Move tool, its mouse wheel and the Resize tool (scale, turn, mirror, Fit / Fill) change the text's own
  settings, so the text always stays editable and sharp. Only Erase, Fill, Merge and stretching one way only still turn text into pixels,
  with a note; Undo brings the editable text back.
- Text number boxes accept decimals (a text made 1.37 times bigger).

## [0.2.0] – 2026-11-06

### Added
- **Text tool, rebuilt.** Click the texture and type; the text is shown exactly as it will be painted. Font list
  (every font installed on the PC, each shown in its own face, searchable) or type any font name, load a `.ttf` / `.otf`
  / `.woff` file, size, bold, italic, underline, strikethrough, ALL CAPS, left / centre / right, letter spacing, line
  height, outline with its own colour, drop shadow (colour, softness, offset), **mirror left-right / up-down**, **turn by
  any angle**, opacity. A ✥ handle moves the text.
- **Text stays editable.** Placed text lives on its own layer (marked **T**) and remembers all its settings. Click it
  again with the Text tool, double-click the layer, or press **Edit text layer** to retype or restyle it. Undo / redo go
  through every edit. Live text is kept in `.csproj` layer files too.
- **Layers panel redesign.** Big buttons with a picture and a word (**New, Duplicate, Up, Down, Lock, Merge, Rename,
  Delete**), disabled when they cannot apply, with clear eye and padlock icons, a layer count and bigger thumbnails.
  New shortcuts: Ctrl+J duplicate, Ctrl+E merge down, Ctrl+] / Ctrl+[ layer up / down.
- Colour wheel with H / S / B and R / G / B boxes, hex field, previous colour, screen pick and recent colours.
- **Resize tool** (move / scale / rotate / flip a layer, exact numbers, Fit / Fill / Stretch) and **layer locking**.
- 3D view **full screen** and **pop-out window** (second monitor), live while you paint.
- **Texture variants**: add `b`, `c`, … with **+**, delete one and the later ones move down a letter (Recycle Bin).
- **Pack editing**: add `.ydd` models (asks what an unnamed model is), move / swap and delete pieces with automatic
  renumbering, add textures from PNG / JPG / WEBP / `.ytd`, keep the pack's `.ymt` in step with the files.
- **Piece options**: audio, flags, render flag, hair scale, high heels, "shows skin" – written to the `.ymt` and the
  creature metadata file exactly the way grzyClothTool does.
- **New pack** and **Build** a clean FiveM resource.
- Safety: Recycle Bin instead of deleting, `.bak` of every changed `.ytd` / `.ymt`, an operation journal that undoes a
  half-finished operation, one operation at a time.
- Automated tests (`npm test`, 100+ tests, no game files needed).

### Changed
- The options bar hides controls that do not apply to the selected tool (for example Mirror for Text).
- Documentation, screenshots and tutorial added.

## [0.1.0]

- First version: open a clothing pack, paint on its textures with layers, live 3D preview, write back into the `.ytd`.
