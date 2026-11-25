// Keyboard shortcuts: which key combination a keydown event is, in one spelling ("Ctrl+Shift+S", "Alt+]", "PageDown", "F1").
// The shortcuts themselves (what each one does) are the table in app.js; this file only reads the keyboard.
//
// This file has no imports and no DOM at load time on purpose: test/keys.test.js evaluates it without a browser, so every
// export must be `export const` / `export function`.

/** The US characters that Shift makes of these keys: Shift+[ arrives as "{", and the shortcut is spelled Shift+[. */
const SHIFTED = { '{': '[', '}': ']', '+': '=', '_': '-', '?': '/', '<': ',', '>': '.', '|': '\\', ':': ';', '"': "'" };
const SHIFTED_CODE = { '{': 'BracketLeft', '}': 'BracketRight', '+': 'Equal', '_': 'Minus', '?': 'Slash', '<': 'Comma', '>': 'Period', '|': 'Backslash', ':': 'Semicolon', '"': 'Quote' };

/**
 * The combination of a keydown event: the modifiers in the order Ctrl, Alt, Shift, then the key (a letter in upper case,
 * named keys as the browser names them: PageDown, Delete, F2, ArrowLeft ...). AltGr (Ctrl+Alt on Windows) types a character,
 * so it counts as no modifier: "[" on a German keyboard (AltGr+8) is "[".
 */
export function comboOf(e) {
  const altGr = !!(e.getModifierState && e.getModifierState('AltGraph'));
  let k = e.key || '';
  if (k === ' ' || k === 'Spacebar') k = 'Space';
  else if (k === 'Esc') k = 'Escape';
  else if (k === 'Del') k = 'Delete';
  else if (k.length === 1) {
    if (e.shiftKey && SHIFTED[k] && e.code === SHIFTED_CODE[k]) k = SHIFTED[k];   // only on the key that makes it on a US keyboard
    else if (k === '+' && e.code === 'NumpadAdd') k = '=';
    k = k.toUpperCase();
  }
  const mods = [];
  if (!altGr && (e.ctrlKey || e.metaKey)) mods.push('Ctrl');
  if (!altGr && e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, k].join('+');
}

/** Does a shortcut of the table fit this event? entry: { keys: ['Ctrl+O', ...], match?(e) } */
export function shortcutMatches(entry, e, combo = comboOf(e)) {
  return (entry.keys || []).includes(combo) || (typeof entry.match === 'function' && !!entry.match(e));
}

/** The number key 1 - 9, 0 pressed (top row or number pad, whatever the layout puts on it), or null: 1 -> 1 ... 0 -> 10. */
export function digitOf(e) {
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '');
  if (!m || e.ctrlKey || e.metaKey || e.altKey) return null;
  return m[1] === '0' ? 10 : Number(m[1]);
}
