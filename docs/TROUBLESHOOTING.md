# Troubleshooting

Find your problem, read the answer. Nothing here needs a programmer.

**First, the safety net:** the first time the app changes a `.ytd` or `.ymt` it keeps the original as `<name>.ytd.bak` /
`<name>.ymt.bak`. Deleted files are in the Windows **Recycle Bin** with their real names. To go back, delete the changed file and
remove `.bak` from the name of the backup, or press **Restore** in the Recycle Bin.

---

## Opening a pack

**"No pieces found" / the Pack list is empty.**
Open the folder that *contains* `stream/` (the resource folder, such as `js_gsp`), not `stream/` itself. Pieces are recognised by
their file names, which need a `^` in them, like `mp_m_freemode_01_gsp^jbib_000_u.ydd` (see [Pack format](PACK-FORMAT.md)).

**"An earlier operation was interrupted…" when I open a pack.**
Normal after a crash or power cut. The app recorded what it was doing, and it has now put the files back the way they were before
that operation. Nothing is lost.

**A piece is missing from the list that is in the folder.**
Check its file name (type, number, `_diff_`, letter, `_uni`/`_whi`). Files that do not follow the FiveM naming are not shown.

## Painting

**My text is blurry or tiny.**
Text size is in *texture pixels*, not screen pixels. A 2000 px texture shown at 31 % zoom looks small: use the Text size box
(try 100–300 on a big texture) and zoom (**1:1**) to check.

**I can't retype my text any more.**
Click it with the **Text** tool, or select its layer and press **Edit text layer**. If the layer has no blue **T**, it was turned into
ordinary pixels. That only happens when you **erase** or **fill** on it, **merge** it with another layer, or stretch it **one way only**
(width and height different) with the Resize tool; a note appears when it happens. Press **Undo** until the **T** is back, or just add
the text again. Painting with the Brush, Line, Rect or Oval does *not* do this: that goes on its own layer above the text. A **locked**
or **hidden** layer cannot be edited until you unlock / show it.

**A "Paint over text" layer appeared.**
That is on purpose: when a text layer is selected and you paint, the paint goes on a layer of its own so the text stays editable.
Rename it, move it, or merge it into the text layer (then the text becomes pixels) as you like.

**The font I want isn't in the list.**
The list shows fonts installed on this PC. Type the exact name into the search box and press Enter, or press **Add font file…** and
choose the `.ttf` / `.otf` (it stays loaded until you close the app).

**Ctrl+Z does something odd while I'm typing text.**
While the text box is active, `Ctrl+Z` is the text box's own undo (undoes typing). The top-bar **Undo** and `Ctrl+Z` outside the box
first throw the open text away.

**Some layer buttons are grey.**
They cannot apply: **Up** is grey on the top layer, **Down** and **Merge** on the bottom layer. A locked layer refuses Delete / Merge
(it says so; press **Unlock**).

**I can't paint on a layer.**
It is probably **locked** (padlock) or **hidden** (eye). The status line says so.

**Paint doesn't show on the model.**
Check you are editing the texture that piece actually uses (the highlighted letter), and that the layer is visible and has some
opacity. For props such as hats the model is shown on the head.

## Saving

**"Save failed".**
The file may be read-only, open in another program, or in a folder Windows protects. Close anything that uses it (a running game
or server) and try again. The app never writes half a file: the new texture is verified before it replaces the old.

**It looks different or blocky in game.**
DXT1 and DXT5 are compressed formats and the app has to compress your painting back into them. Flat colours, logos and text are
fine; smooth photographic gradients can band. If the texture is **A8R8G8B8** nothing is lost. A texture can only be saved in the
format and size it already has.

**I saved, but nothing changes in game.**
`refresh`, then `restart <your resource>` on the server, or restart the server. FiveM clients may keep a cache: rejoining or
clearing the client's cache for that server fixes stubborn cases. Make sure you edited the texture letter you are looking at
(`a`, `b` …).

## The `.ymt`

**The top bar says ".ymt ≠ files".**
Click it. It lists what differs (for example *Hat 000 has 2 textures listed but 3 files*) and **Update .ymt** fixes it. Only counts and
missing pieces change; everything else in the file stays.

**It says it can't update a `.ymt`.**
A `.ymt` with data the app does not understand is left alone on purpose. Your original is untouched. You can still use the app for
painting.

**A texture I added shows nothing in game.**
The `.ymt` must list it: the chip should say **.ymt ✓**.

## Pieces

**I deleted the wrong piece / texture.**
The files are in the Windows Recycle Bin under their real names. When you deleted, later pieces moved down a number, so the old
names are in use again: if you restore to the original folder Windows will ask whether to *replace* files. Say **no**. Instead
restore them to your Desktop (right-click → Restore to … or drag them out), then press **Add piece…** in the app and choose the
restored `.ydd` and its textures: it files them under the next free number and updates the `.ymt`. A deleted *texture* (a
letter) is the same: restore the `.ytd` somewhere else and use **Add textures…** on the piece.

**Hair pokes through my hat.**
Open **Options** on the hat and turn on **Enable hair scale** (try 0.35; smaller squashes more).

**The character sinks into the floor in my shoes / floats.**
Use **High heels** in the shoe's options to lift (larger = taller). Remember it needs the creature metadata the app writes.

**Add piece says "what is this?"**
The model's name does not say what it is. Pick the category (badge, hat, pants …), male or female, and whether it shows skin.

**My `.meta` still lists the old numbers.**
The app does not edit `.meta` files, and warns you after a move or delete if your pack has ones that list pieces by number
(`first_person_alternates_*.meta`, `pedalternativevariations_*.meta`). Edit those by hand.

## The 3D view

**The 3D view is black.**
Your graphics driver may not provide WebGL to the app. Update the driver, or try **Pop out** (a second window). Make sure a piece
is selected.

**The Body button asks for the GTA V folder / does nothing.**
The mannequin is read from your own **legacy** GTA V installation. Press **Body** and choose the folder with `GTA5.exe` in it. The first
time takes about a minute (the key search); after that it is instant. Without GTA V the rest of the app works normally.

**Pop out opens on the wrong monitor.**
Drag the window where you want it; press `F11` / double-click for full screen there.

## The app itself

**Windows says "unknown publisher" / antivirus warns about the .exe.**
The packaged app is not code-signed and is built from open source on your own machine (`npm run package`). If in doubt, run it from
source with `npm start`.

**The window looks cramped.**
Make the window bigger or maximise it. The options bar above the canvas wraps onto more lines in a narrow window (the Text tool has
the most controls). **Full** and **Pop out** give the 3D view more room.

**Something else.**
Please open an issue (see [CONTRIBUTING](../CONTRIBUTING.md)) with what you did, what you expected and what happened. A screenshot
helps; do not post files from other people's paid packs.
