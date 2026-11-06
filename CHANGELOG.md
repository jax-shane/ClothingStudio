# Changelog

All notable changes to ClothingStudio. The format follows [Keep a Changelog](https://keepachangelog.com/).

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
