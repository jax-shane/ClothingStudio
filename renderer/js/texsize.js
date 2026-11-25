// Which texture sizes ClothingStudio offers when an image is bigger than the texture it is going into (like Paint.NET's
// "keep the canvas / resize the canvas" question). Pure functions, no page in sight: app.js asks the questions, this file
// decides what there is to ask. Covered by test/texsize.test.js, which loads this file without a browser - so keep it free
// of imports and DOM, and write every export as `export const` or `export function`.
//
// A texture's size lives in its .ytd and the game wants powers of two, so the choices are the texture's own size doubled
// (2x, 4x ...) up to MAX_SIDE, which must match ytd.MAX_RESIZE in src/lib/ytd.js (a test keeps the two in step).

export const MAX_SIDE = 4096;

/**
 * The sizes a texture of docW x docH can grow to for an image of imgW x imgH, smallest first: [{ scale, w, h }].
 * Empty when there is nothing to ask: the image is not bigger than the texture in both directions (a wide banner or a
 * small logo just gets fitted), or the texture is already as big as it can get. The list stops at the first size that holds
 * the whole image at its own pixels.
 */
export function growSizes(docW, docH, imgW, imgH) {
  if (!(imgW > docW && imgH > docH)) return [];
  const need = Math.max(imgW / docW, imgH / docH);
  const out = [];
  for (let s = 2; Math.max(docW, docH) * s <= MAX_SIDE; s *= 2) {
    out.push({ scale: s, w: docW * s, h: docH * s });
    if (s >= need) break;
  }
  return out;
}

/**
 * Add pieces / Add textures: every picked image is stretched to the size of the pack's textures (tplW x tplH). The size one
 * image gets when textures may grow up to `cap` pixels on their longest side (0 = keep the pack's size): the smallest
 * doubling of the template that holds the image, but not past the cap.
 */
export function textureSizeFor(tplW, tplH, imgW, imgH, cap) {
  const keep = { w: tplW, h: tplH, resize: false };
  if (!cap || !(imgW > tplW && imgH > tplH)) return keep;
  const need = Math.max(imgW / tplW, imgH / tplH), limit = Math.min(cap, MAX_SIDE);
  let s = 1;
  while (s < need && Math.max(tplW, tplH) * s * 2 <= limit) s *= 2;
  return s === 1 ? keep : { w: tplW * s, h: tplH * s, resize: true };
}

/**
 * The question of the Add flows. items: [{ name, w, h, tplW, tplH }], one per image that is about to become a texture.
 * Returns null when there is nothing to ask, else { bigger: the items that could get a bigger texture, caps: the longest sides
 * the user can allow, smallest first, for example [2048, 4096] }.
 */
export function addChoices(items) {
  const bigger = [], caps = new Set();
  for (const i of items) {
    const sizes = growSizes(i.tplW, i.tplH, i.w, i.h);
    if (!sizes.length) continue;
    bigger.push(i);
    for (const s of sizes) caps.add(Math.max(s.w, s.h));
  }
  return bigger.length ? { bigger, caps: [...caps].sort((a, b) => a - b) } : null;
}

/** About how much memory a texture with its mip levels takes in game, in MB (DXT1 half a byte per pixel, DXT5 one, uncompressed four, plus a third for the mips). */
export function memoryMB(w, h, format) {
  const bytesPerPixel = format === 'DXT5' ? 1 : format === 'A8R8G8B8' ? 4 : 0.5;
  return (w * h * bytesPerPixel * 4 / 3) / (1024 * 1024);
}

/** "0.7 MB", "2.7 MB", "11 MB" */
export const mbText = (mb) => (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + ' MB';
