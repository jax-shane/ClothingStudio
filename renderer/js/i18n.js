// The interface in other languages.
//
// Every user-visible English string in the code is written t('English text') and the English text is the key: a language that
// has no translation for a string simply shows the English, so a language file can be half finished. Texts with a number use
// tn(n, 'one thing', 'many things') and a language file may then give one form per plural category of that language
// (one / few / many / other, from the browser's own CLDR rules). {name} marks a value that is filled in.
//
// Language files are renderer/lang/<code>.js (export default { name, dir, strings }); renderer/lang/en.js is the generated list of
// every string (tools/i18n.js). The static text of index.html is translated by applyStatic, which matches whole texts.
//
// This file has no imports and no DOM at load time on purpose: test/i18n.test.js evaluates it without a browser, so every
// export must be `export const` / `export function` / `export async function`.

// code: the file name of renderer/lang/<code>.js; name: the language in its own language; english: its English name; short: what the language button shows
export const LANGUAGES = [
  { code: 'en', name: 'English', english: 'English', short: 'EN' },
  { code: 'ar', name: 'العربية', english: 'Arabic', short: 'AR' },
  { code: 'nl', name: 'Nederlands', english: 'Dutch', short: 'NL' },
  { code: 'fr', name: 'Français', english: 'French', short: 'FR' },
  { code: 'de', name: 'Deutsch', english: 'German', short: 'DE' },
  { code: 'it', name: 'Italiano', english: 'Italian', short: 'IT' },
  { code: 'pl', name: 'Polski', english: 'Polish', short: 'PL' },
  { code: 'pt-br', name: 'Português (Brasil)', english: 'Portuguese (Brazil)', short: 'PT' },
  { code: 'ru', name: 'Русский', english: 'Russian', short: 'RU' },
  { code: 'es', name: 'Español', english: 'Spanish', short: 'ES' },
  { code: 'tr', name: 'Türkçe', english: 'Turkish', short: 'TR' },
];

/** Languages written right to left. The layout of the editor is not mirrored: only the text direction of the words is. */
export const RTL = ['ar', 'he', 'fa', 'ur'];

let strings = Object.create(null);
let lang = 'en';
let rules = new Intl.PluralRules('en');

/** Use a language: `data` is what the language file exports (or null for English). */
export function setLanguage(code, data) {
  lang = code || 'en';
  strings = (data && data.strings) || Object.create(null);
  try { rules = new Intl.PluralRules(lang); } catch { rules = new Intl.PluralRules('en'); }
}
export const getLanguage = () => lang;
export const isRtl = (code) => RTL.includes(String(code || lang).split('-')[0].toLowerCase());

const fill = (s, params) => (params ? s.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k]))) : s);

/** The text in the current language (the key itself when there is no translation), with {name} replaced from params. */
export function t(key, params) {
  const v = strings[key];
  return fill(typeof v === 'string' && v ? v : key, params);
}

/** A text with a number: `one` for exactly 1 in English, `other` otherwise; {n} is the number. The catalog key is the `other` text. */
export function tn(n, one, other, params) {
  const p = Object.assign({ n }, params);
  const v = strings[other];
  if (v && typeof v === 'object') return fill(v[rules.select(n)] || v.other || (n === 1 ? one : other), p);
  if (typeof v === 'string' && v) return fill(v, p);
  return fill(n === 1 ? one : other, p);
}

/** A message that may come from the engine as plain text or as { key, params } (texts that carry values). */
export const tm = (m) => (m && typeof m === 'object' && typeof m.key === 'string' ? t(m.key, m.params) : t(String(m)));

/** "a, b and c" in the current language. */
export function list(items) {
  try { return new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }).format(items); } catch { return items.join(', '); }
}

/** Sentences one after the other: with a space between them, except in Chinese and Japanese, which do not put one. */
export const sentences = (...parts) => parts.filter((p) => p !== undefined && p !== null && p !== '').join(/^(zh|ja)\b/i.test(lang) ? '' : ' ');

/**
 * Which language to start in: the one the user chose, else the first language of the system that is available (a regional
 * variant falls back to its language, Portuguese to Brazilian Portuguese, Chinese by script), else English.
 */
export function pickLanguage(saved, preferred, available = LANGUAGES.map((l) => l.code)) {
  const has = (c) => available.find((a) => a.toLowerCase() === String(c).toLowerCase());
  if (saved && has(saved)) return has(saved);
  for (const raw of preferred || []) {
    const c = String(raw).replace('_', '-');
    const [base, region] = c.split('-');
    const b = base.toLowerCase(), r = (region || '').toUpperCase();
    const mapped = b === 'zh' ? (/^(TW|HK|MO)$/.test(r) || /^hant$/i.test(region || '') ? 'zh-TW' : 'zh-CN')
      : b === 'pt' ? 'pt-BR' : b === 'nb' || b === 'nn' ? 'no' : b === 'iw' ? 'he' : b === 'in' ? 'id' : null;
    const found = has(c) || (mapped && has(mapped)) || has(b);
    if (found) return found;
  }
  return 'en';
}

/** Load a language file. English needs none. */
export async function loadLanguage(code) {
  if (!code || code === 'en') return null;
  const mod = await import('../lang/' + String(code).toLowerCase() + '.js');
  return mod.default;
}

/**
 * Show the page in a language: load its file, switch t(), set the page's lang and text direction, translate the static text.
 * Returns the language that is now shown (English when the file could not be loaded).
 */
export async function showLanguage(code) {
  let data = null;
  try { data = await loadLanguage(code); } catch (e) { console.error('language file ' + code, e); code = 'en'; }
  setLanguage(code, data);
  const root = document.documentElement;
  root.lang = code || 'en';
  root.dataset.dir = isRtl(code) ? 'rtl' : 'ltr';          // the layout is not mirrored; this only steers how the words of a text run (style.css)
  applyStatic(document.body);
  return code || 'en';
}

/**
 * The language to start in: ?lang=xx in the address (the browser test page), else what the user chose, else the system's.
 * It also tells the main process (for the native dialogs and error messages) without saving it as a choice.
 */
export async function startLanguage(api) {
  let info = { saved: null, system: [] };
  try { info = (await api.getLanguage()) || info; } catch { /* English */ }
  let forced = null;
  try { forced = new URLSearchParams(location.search).get('lang'); } catch { /* no address */ }
  const code = forced && (forced === 'pseudo' || /^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(forced)) ? forced : pickLanguage(info.saved, info.system);
  const shown = await showLanguage(code);
  try { await api.setLanguage(shown, false); } catch { /* the dialogs of the main process stay English */ }
  return shown;
}

// ---- static text: the text nodes and the title / placeholder / aria-label / alt attributes of a page (or part of it)
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
const done = new WeakMap();                                // text node or element -> what was there in English and what was put there
const norm = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Translate the text of `root` whose whole text is a known English string. The English is remembered, so changing language later
 * translates from the English again; text the program changed in the meantime is left alone.
 */
export function applyStatic(root) {
  const doc = root.ownerDocument || root;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode: (n) => (/^(SCRIPT|STYLE|TEXTAREA)$/.test(n.parentNode.nodeName) || (n.parentElement && n.parentElement.closest('[translate="no"]')) ? 2 : 1),
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const n of nodes) {
    const rec = done.get(n);
    if (rec && n.nodeValue !== rec.shown) continue;
    const orig = rec ? rec.orig : n.nodeValue;
    const key = norm(orig);
    if (!key) continue;
    const to = t(key);
    const lead = /^\s*/.exec(orig)[0], trail = /\s*$/.exec(orig)[0];
    const shown = to === key ? orig : lead + to + trail;
    if (shown !== n.nodeValue) n.nodeValue = shown;
    done.set(n, { orig, shown });
  }
  const els = [...(root.querySelectorAll ? root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(',')) : [])];
  if (root.getAttribute) els.unshift(root);
  for (const el of els) {
    let rec = done.get(el);
    if (!rec) { rec = {}; done.set(el, rec); }
    for (const a of ATTRS) {
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      const cur = el.getAttribute(a), r = rec[a];
      if (r && cur !== r.shown) continue;
      const orig = r ? r.orig : cur, key = norm(orig);
      if (!key) continue;
      const to = t(key), shown = to === key ? orig : to;
      if (shown !== cur) el.setAttribute(a, shown);
      rec[a] = { orig, shown };
    }
  }
}
