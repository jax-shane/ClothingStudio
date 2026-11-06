# Third-party notices

ClothingStudio is free software under the **GNU General Public License v3.0 or later** (see [LICENSE](LICENSE)).
It would not exist without the work of the people and projects below. Thank you.

## CodeWalker (GPL-3.0)

<https://github.com/dexyfex/CodeWalker> by dexyfex and contributors.

ClothingStudio reads and writes GTA V file formats using layouts that were worked out in CodeWalker. The code in this
repository was written for ClothingStudio in JavaScript, but these parts follow CodeWalker's format knowledge closely
and two data files come straight from it, which is why the whole project is GPL-3.0:

| Part | What it takes from CodeWalker |
|---|---|
| `src/lib/rsc.js`, `src/lib/ytd.js`, `src/lib/ydd.js`, `src/lib/skeleton.js` | RSC7 resource container, texture dictionary, drawable and skeleton layouts |
| `src/lib/rpf.js`, `src/lib/gtakeys.js` | RPF7 archive layout, NG decryption, the method of finding the archive keys inside a game executable |
| `src/lib/key_hashes.json` | SHA-1 digests of the keys (digests only; no key material) – from CodeWalker |
| `src/lib/magic.dat` | an obfuscated data blob from CodeWalker that only becomes useful with the AES key found in *your own* `GTA5.exe` |
| `src/lib/ymt.js`, `src/lib/ymt_types.json` | the "Meta" resource layout of `CPedVariationInfo` (MetaBuilder), including structure hashes |
| `src/lib/rbf.js` | the RBF0 binary-XML format (CodeWalker's `RbfFile.cs`) |
| `src/lib/options.js` | enum values such as `ePropRenderFlags` and the drawable flag names |

## grzyClothTool

<https://github.com/grzybeek/grzyClothTool> by grzybeek.

ClothingStudio is an independent project, but it deliberately produces the same kind of output as grzyClothTool so
that packs can be moved between the two: the `.ymt` layout, the creature-metadata rules for hair scale and high
heels, the lists of audio / flag / render options, and the FiveM resource layout written by **Build**. Please see that
project's own repository for its licence and for the many things it does that ClothingStudio does not.

## Neodymium (MIT)

The RBF0 format description that CodeWalker's `RbfFile.cs` is itself based on.

## three.js (MIT)

<https://threejs.org/> – the 3D preview (`node_modules/three`, bundled into the packaged app).

## Electron (MIT)

<https://www.electronjs.org/> – the desktop shell. The packaged app contains Chromium and Node.js, each under their
own open-source licences (shipped in the app folder as `LICENSES.chromium.html` and `LICENSE`).

## Trademarks and game content

ClothingStudio is a fan-made tool. It is **not affiliated with, endorsed by or supported by Rockstar Games, Take-Two
Interactive, Cfx.re or FiveM**. *Grand Theft Auto* and *GTA V* are trademarks of Take-Two Interactive.

No game assets are included in this repository. The optional mannequin in the 3D preview is read at run time from a
copy of GTA V that **you** own and is never copied anywhere else. You are responsible for following the terms of the
games and servers you make content for, and for having the right to modify and use any clothing pack you open with it.
