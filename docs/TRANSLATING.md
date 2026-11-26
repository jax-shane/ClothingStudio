# Translating ClothingStudio

ClothingStudio can show its interface in many languages. Press the **🌐** button at the top right to change it; "Automatic" follows the language of your PC.
Most translations were first made by machine and have not been checked by native speakers, so a native speaker's help is welcome: a fix is a one-line change in a text file.

## How it works

* Every text of the program is written in English in the code, `t('Save to YTD')`, and **the English text is the key**. A language file maps English text to its translation. A text a language does not translate is simply shown in English, so a language file can be half finished.
* `renderer/lang/<code>.js` is one language (`de.js`, `pt-br.js`, `zh-cn.js` ...). `renderer/lang/en.js` is the generated list of every text with a note on where it is used; it is the file to translate from.
* The list of languages in the picker is `LANGUAGES` in `renderer/js/i18n.js`.

## Add or improve a language

1. Make `renderer/lang/<code>.js` (use the language's own code, lower case, for example `sv` or `pt-br`) in this shape:

   ```js
   export default {
     name: 'Deutsch',          // the language in its own language
     dir: 'ltr',               // 'rtl' for Arabic and Hebrew
     strings: {
       'Open pack…': 'Pack öffnen…',
       'Cancel': 'Abbrechen',
       // a text with a number has one form per plural category of the language (the checker says which ones it needs)
       '{n} pieces': { one: '{n} Teil', other: '{n} Teile' },
     },
   };
   ```

2. Add the language to `LANGUAGES` in `renderer/js/i18n.js`: `{ code: 'de', name: 'Deutsch', english: 'German', short: 'DE' }`.
3. `node tools/i18n.js missing de` lists what is not translated yet. `node tools/i18n.js check de` checks the file (see below). `npm test` runs the same checks on every language.
4. Run the program (`npm start`, or `npm run dev` and open `http://localhost:5173/renderer/index.html?lang=de`) and look at every screen: texts that are too long show up as cut-off buttons.

If you change an English text in the code, or add one, run `node tools/i18n.js extract` to renew `renderer/lang/en.js`. The old English text becomes "not in the catalog" in the language files; `node tools/i18n.js check` lists those so they can be renewed.

## Rules for a translation

* Keep `{placeholders}` exactly as they are (`{n}`, `{name}`, `{file}` ...). They are filled in by the program and may move within the sentence. `{n}` is a number.
* Keep a trailing `…` where the English has one (it means "a dialog follows").
* Do not translate: ClothingStudio, FiveM, GTA V, OpenIV, file names and extensions (`.ytd`, `.ydd`, `.ymt`, `.meta`, `dlc.rpf`, `fxmanifest.lua`), texture formats (DXT1, DXT5, BC7, A8R8G8B8), PNG / JPG / WEBP, `UV`, `mips`, `PRF_ALPHA` and the other flag names, key names like Ctrl, Shift, Alt, Esc, Enter, F11 (write them as they are printed on keyboards of that language, for example Strg in German).
* Words in quotation marks that name a button or a panel ("Add piece…", "Save to YTD") must be the same words as that button's translation.
* Use the words that Windows, Photoshop / Paint.NET and GTA V modding use in that language: "Recycle Bin" is the word of Windows in that language, the blend modes (Multiply, Screen, Overlay ...) the names of the painting programs.
* Buttons are small: keep a label about as short as the English one. The checker warns about texts that are much longer.
* A **pack** is a clothing resource folder, a **piece** is one clothing item (a top, a hat ...), a **texture** is the picture painted on a piece (a, b, c ...).

## What the checker looks for

`node tools/i18n.js check` reports **errors** (the file is not used correctly): a text that is not in `en.js`, a changed `{placeholder}`, a missing or unknown plural form, an empty text, markup added. And **warnings**: leading / trailing spaces, a missing `…`, a text that is much longer or shorter than the English.

## Testing without a translator: the pseudo language

`node tools/i18n.js pseudo` writes `renderer/lang/pseudo.js`, a language that accents every letter and makes texts 30 % longer, in `[brackets]`. Open the program with `?lang=pseudo` (browser test page): a text that is **not** accented is missing from the catalog, and a text that is cut off will not fit in a language with long words. Delete the file before packaging (`npm run package` leaves it out).

## Right-to-left languages

For Arabic and Hebrew (`dir: 'rtl'`) the words of a text run right to left, but the layout of the editor (panels, toolbars, the canvas) is not mirrored.
