'use strict';
// Translation tooling.
//   node tools/i18n.js extract     rebuild renderer/lang/en.js, the list of every user-visible string (run it after changing any text)
//   node tools/i18n.js check [de]  check every renderer/lang/<code>.js (or just that one) against that list (placeholders, plural forms, lengths ...)
//   node tools/i18n.js missing de  list what renderer/lang/de.js does not translate yet
//   node tools/i18n.js pseudo      write renderer/lang/pseudo.js, a test language (accented, 30% longer): ?lang=pseudo on the browser test page
//
// Where the strings come from: t('...') / tn(n, '...', '...') / nt('...') / T('...') / N_('...') in the JavaScript, emit('warn' | 'note', '...')
// in paint.js, and the text nodes and title / placeholder / aria-label / alt attributes of the HTML pages. The English text is the key.
// (N_('...') only marks a text in a table; the text is translated where it is shown.)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_FILES = ['renderer/js/app.js', 'renderer/js/pieces.js', 'renderer/js/paint.js', 'renderer/js/viewer-window.js', 'main.js'];
const HTML_FILES = ['renderer/index.html', 'renderer/viewer-window.html'];
const LANG_DIR = path.join(ROOT, 'renderer', 'lang');

// ------------------------------------------------------------------ reading JavaScript
/** the string literal that starts at src[i] (a quote), or null when it is not a plain string (an interpolated template, a line break ...) */
function readLiteral(src, i) {
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
  let j = i + 1, out = '';
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      const n = src[j + 1];
      if (n === 'u') {
        if (src[j + 2] === '{') { const e = src.indexOf('}', j); out += String.fromCodePoint(parseInt(src.slice(j + 3, e), 16)); j = e + 1; } else { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; }
      } else if (n === 'x') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)); j += 4; }
      else if (n === '\n') j += 2;
      else { out += n in simple ? simple[n] : n; j += 2; }
      continue;
    }
    if (c === q) return { value: out, end: j + 1 };
    if (q === '`' && c === '$' && src[j + 1] === '{') return null;
    if (c === '\n' && q !== '`') return null;
    out += c; j++;
  }
  return null;
}

/** index of the closing quote of the string or template literal that starts at i (templates may nest ${ ... }) */
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === q) return j;
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      let depth = 1;
      for (j += 2; j < src.length && depth; j++) {
        if (src[j] === "'" || src[j] === '"' || src[j] === '`') j = skipString(src, j);
        else if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
      }
      j--;
    }
  }
  return src.length;
}

/** the top-level arguments of the call whose "(" is at src[open]: [{ start, end }] */
function callArgs(src, open) {
  let depth = 0, start = open + 1;
  const out = [];
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { out.push({ start, end: i }); return out; }
      depth--;
    } else if (c === ',' && depth === 0) { out.push({ start, end: i }); start = i + 1; }
  }
  return out;
}

/** the argument is exactly one plain string literal: its value, else null */
function literalArg(src, a) {
  const s = src.slice(a.start, a.end);
  const k = s.search(/\S/);
  if (k < 0) return null;
  const lit = readLiteral(s, k);
  return lit && !s.slice(lit.end).trim() ? lit.value : null;
}

const lineOf = (src, i) => src.slice(0, i).split('\n').length;

/** The source with every comment blanked out (same length and line breaks), so a t('...') that is only mentioned in a comment is not a string. */
function stripComments(src) {
  let out = '', i = 0, last = '';                          // last: the last character that is not blank and not in a comment
  const regexAllowed = () => !last || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|else|do)\s*$/.test(out.slice(-12));
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i), end = e < 0 ? src.length : e; out += ' '.repeat(end - i); i = end; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2), end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    if (c === "'" || c === '"' || c === '`') { const e = skipString(src, i); out += src.slice(i, e + 1); i = e + 1; last = c; continue; }
    if (c === '/' && regexAllowed()) {                    // a regular expression literal: its quotes are not strings
      let j = i + 1, cls = false;
      for (; j < src.length; j++) {
        const d = src[j];
        if (d === '\\') { j++; continue; }
        if (d === '\n') break;
        if (cls) { if (d === ']') cls = false; } else if (d === '[') cls = true; else if (d === '/') break;
      }
      out += src.slice(i, j + 1); i = j + 1; last = '/'; continue;
    }
    out += c; if (!/\s/.test(c)) last = c; i++;
  }
  return out;
}

function scanJs(file, found, dynamic) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const add = (key, i, plural) => {
    if (!key || !/[A-Za-z]{2}/.test(key)) return;
    const e = found.get(key) || { where: [], one: null, ctx: '' };
    e.where.push(`${file}:${lineOf(src, i)}`);
    if (plural) e.one = plural;
    if (!e.ctx) {                                          // the line of code it is on: tells a translator what the text is for
      const from = src.lastIndexOf('\n', i) + 1, to = src.indexOf('\n', i);
      e.ctx = src.slice(from, to < 0 ? src.length : to).trim().replace(/\s+/g, ' ').slice(0, 110);
    }
    found.set(key, e);
  };
  for (const m of src.matchAll(/(?<![\w$.])(t|nt|T|N_)\(/g)) {
    const open = m.index + m[0].length - 1;
    const a = callArgs(src, open)[0];
    if (!a) continue;
    const v = literalArg(src, a);
    if (v !== null) add(v, m.index); else dynamic.push(`${file}:${lineOf(src, m.index)}  ${m[1]}(${src.slice(a.start, a.end).trim().slice(0, 60)})`);
  }
  for (const m of src.matchAll(/(?<![\w$.])tn\(/g)) {
    const a = callArgs(src, m.index + m[0].length - 1);
    const one = a[1] && literalArg(src, a[1]), other = a[2] && literalArg(src, a[2]);
    if (one !== null && other !== null && one !== undefined && other !== undefined) add(other, m.index, one);
    else dynamic.push(`${file}:${lineOf(src, m.index)}  tn(...)`);
  }
  for (const m of src.matchAll(/emit\(\s*'(?:warn|note)'\s*,\s*/g)) {         // paint.js hands its messages to the page as plain text or { key, params }
    const at = m.index + m[0].length;
    const lit = readLiteral(src, at);
    if (lit) { add(lit.value, m.index); continue; }
    const k = /^\{\s*key:\s*/.exec(src.slice(at));
    if (k) { const l2 = readLiteral(src, at + k[0].length); if (l2) add(l2.value, m.index); }
  }
}

// ------------------------------------------------------------------ reading HTML
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&times;/g, '×').replace(/&hellip;/g, '…').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

function scanHtml(file, found) {
  const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const html = raw.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/<textarea([^>]*)>[\s\S]*?<\/textarea>/g, '<textarea$1/>')
    .replace(/<([a-z][a-z0-9]*)\b[^>]*\stranslate="no"[^>]*>[\s\S]*?<\/\1>/g, '<x/>');     // translate="no": the product name, font names ...
  const add = (key, i) => {
    if (!/[A-Za-z]{2}/.test(key) || /^[A-Z]{2,3}$/.test(key) || /^\.[a-z]{2,5}$/.test(key)) return;         // not text (TT, UV, .ymt ...)
    const e = found.get(key) || { where: [], one: null, ctx: '' };
    e.where.push(`${file}:${lineOf(html, i)}`);
    if (!e.ctx) {                                          // the element it is in: <button id="xFill"> -> "button #xFill"
      const open = html.lastIndexOf('<', i), tag = html.slice(open, html.indexOf('>', open) + 1);
      const name = (/^<([a-z0-9]+)/.exec(tag) || [])[1] || '', id = (/\sid="([^"]+)"/.exec(tag) || [])[1], cls = (/\sclass="([^"]+)"/.exec(tag) || [])[1];
      e.ctx = `${name}${id ? ' #' + id : cls ? ' .' + cls.split(' ')[0] : ''} in ${path.basename(file)}`;
    }
    found.set(key, e);
  };
  for (const m of html.matchAll(/>([^<>]+)</g)) add(norm(decode(m[1])), m.index);
  for (const m of html.matchAll(/\s(?:title|placeholder|aria-label|alt)="([^"]*)"/g)) add(norm(decode(m[1])), m.index);
}

// ------------------------------------------------------------------ the catalog
function extract() {
  const found = new Map(), dynamic = [];
  for (const f of HTML_FILES) scanHtml(f, found);
  for (const f of JS_FILES) scanJs(f, found, dynamic);
  return { found, dynamic };
}

const quote = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";

function catalogSource(found) {
  const keys = [...found.keys()];
  const lines = keys.map((k) => {
    const e = found.get(k), note = e.ctx ? ` // ${e.ctx}` : '';
    return e.one ? `    ${quote(k)}: { one: ${quote(e.one)}, other: ${quote(k)} },${note}` : `    ${quote(k)}: ${quote(k)},${note}`;
  });
  return `// GENERATED by tools/i18n.js (node tools/i18n.js extract): every user-visible string of ClothingStudio, in English. Do not edit.
// A text with a number is { one, other }: a language file gives one text per plural category of its language instead.
export default {
  name: 'English',
  dir: 'ltr',
  strings: {
${lines.join('\n')}
  },
};
`;
}

// ------------------------------------------------------------------ language files
/** the object a language file exports (the files are plain `export default { ... };` modules) */
function readLanguageFile(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const m = /export\s+default\s*/.exec(src);
  if (!m) throw new Error('no "export default" in ' + file);
  return new Function('return (' + src.slice(m.index + m[0].length).replace(/;\s*$/, '') + ');')();
}

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Problems in a language file measured against the catalog: [{ level: 'error' | 'warn', key, message }].
 * errors: a text the catalog does not have, a changed {placeholder}, a plural form missing or not allowed, an empty text, markup added.
 */
function checkLanguage(code, data, catalog) {
  const problems = [];
  const err = (key, message) => problems.push({ level: 'error', key, message });
  const warn = (key, message) => problems.push({ level: 'warn', key, message });
  if (!data || typeof data !== 'object') return [{ level: 'error', key: '', message: 'the file does not export an object' }];
  if (typeof data.name !== 'string' || !data.name) err('', 'name is missing (the language in its own language)');
  if (!['ltr', 'rtl'].includes(data.dir)) err('', 'dir must be "ltr" or "rtl"');
  const rtl = ['ar', 'he', 'fa', 'ur'].includes(code.split('-')[0].toLowerCase());
  if (data.dir && (data.dir === 'rtl') !== rtl) err('', `dir should be ${rtl ? 'rtl' : 'ltr'} for ${code}`);
  let cats;
  try { cats = new Intl.PluralRules(code).resolvedOptions().pluralCategories; } catch { cats = ['one', 'other']; err('', `${code} is not a language code the browser knows`); }
  // Spanish, French, Italian and Portuguese have "many" only for numbers like 1 000 000 and newer ICU versions know it, older ones not:
  // it may be given but is not needed (tn() falls back to "other").
  const base = code.split('-')[0].toLowerCase(), compact = ['es', 'fr', 'it', 'pt', 'ca'].includes(base);
  const required = compact ? cats.filter((c) => c !== 'many') : cats, allowed = compact ? [...new Set([...cats, 'many'])] : cats;
  for (const [key, val] of Object.entries(data.strings || {})) {
    const src = catalog.strings[key];
    if (src === undefined) { err(key, 'not in the catalog (the English text changed or has a typo; run: node tools/i18n.js missing ' + code + ')'); continue; }
    const want = placeholders(typeof src === 'object' ? src.other : src);
    const forms = typeof val === 'object' && val ? val : null;
    if (typeof src === 'object') {
      if (forms) {
        for (const c of required) if (typeof forms[c] !== 'string' || !forms[c]) err(key, `plural form "${c}" is missing (${code} needs: ${required.join(', ')})`);
        for (const c of Object.keys(forms)) if (!allowed.includes(c)) err(key, `plural form "${c}" does not exist in ${code} (it has: ${allowed.join(', ')})`);
      } else if (typeof val !== 'string' || !val) err(key, 'empty');
    } else if (typeof val !== 'string' || !val.trim()) { err(key, 'empty or not text'); continue; }
    for (const v of forms ? Object.values(forms) : [val]) {
      if (typeof v !== 'string') continue;
      if (!eq(placeholders(v), want) && !(forms && placeholders(v).every((p) => want.includes(p)))) err(key, `placeholders differ: English has ${JSON.stringify(want)}, this has ${JSON.stringify(placeholders(v))}`);
      if (/<\/?[a-z][^>]*>/i.test(v) && !/<\/?[a-z][^>]*>/i.test(typeof src === 'object' ? src.other : src)) err(key, 'markup was added');
      if (/^\s|\s$/.test(v)) warn(key, 'starts or ends with a space');
      const en = typeof src === 'object' ? src.other : src;
      if (en.endsWith('…') && !v.endsWith('…') && !v.endsWith('...')) warn(key, 'the English ends with "…" (a dialog follows) and this does not');
      if (en.length >= 4 && (v.length > en.length * 3 + 12 || v.length * 4 + 12 < en.length)) warn(key, `length ${v.length} against ${en.length} in English: check it`);
    }
  }
  return problems;
}

// ------------------------------------------------------------------ pseudo-language (for testing the layout and finding texts that are not translated)
const ACCENTS = { a: 'à', b: 'ƀ', c: 'ç', d: 'ď', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ö', p: 'ƥ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Â', B: 'Ɓ', C: 'Ç', D: 'Ď', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Ƥ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž' };
/** "Save to YTD" -> "[Šàṽé ţö ÝŢĎ··]": accented (so what is not translated stands out), 30% longer (the layout is tested), {placeholders} kept. */
const pseudo = (s) => '[' + s.replace(/\{\w+\}|[A-Za-z]/g, (m) => (m[0] === '{' ? m : ACCENTS[m] || m)) + '·'.repeat(Math.ceil(s.length * 0.3)) + ']';
function pseudoSource(catalog) {
  const lines = Object.entries(catalog.strings).map(([k, v]) => {
    if (typeof v === 'object') return `    ${quote(k)}: { one: ${quote(pseudo(v.one))}, other: ${quote(pseudo(v.other))} },`;
    return `    ${quote(k)}: ${quote(pseudo(v))},`;
  });
  return `// GENERATED by tools/i18n.js (node tools/i18n.js pseudo): a test language, not shipped. Use it with ?lang=pseudo on the browser test page.
export default {
  name: 'Pseudo',
  dir: 'ltr',
  strings: {
${lines.join('\n')}
  },
};
`;
}

function languageCodes() {
  if (!fs.existsSync(LANG_DIR)) return [];
  return fs.readdirSync(LANG_DIR).filter((f) => /^[a-z]{2,3}(-[a-z]{2,4})?\.js$/.test(f) && f !== 'en.js').map((f) => f.slice(0, -3));
}

function coverage(data, catalog) {
  const total = Object.keys(catalog.strings).length;
  const done = Object.keys(catalog.strings).filter((k) => { const v = (data.strings || {})[k]; return typeof v === 'string' ? v.trim() : v && Object.keys(v).length; }).length;
  return { total, done, missing: total - done };
}

module.exports = { extract, catalogSource, readLanguageFile, checkLanguage, languageCodes, coverage, readLiteral, callArgs, stripComments, pseudo, LANG_DIR, ROOT };

// ------------------------------------------------------------------ command line
if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const { found, dynamic } = extract();
  if (cmd === 'extract') {
    fs.mkdirSync(LANG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LANG_DIR, 'en.js'), catalogSource(found), 'utf8');
    console.log(`renderer/lang/en.js: ${found.size} strings`);
    if (dynamic.length) console.log(`${dynamic.length} t()/tn() calls take a value that is not a plain text (fine for error messages, check the others):\n  ` + dynamic.join('\n  '));
  } else if (cmd === 'pseudo') {
    fs.writeFileSync(path.join(LANG_DIR, 'pseudo.js'), pseudoSource(readLanguageFile(path.join(LANG_DIR, 'en.js'))), 'utf8');
    console.log('renderer/lang/pseudo.js written (a test language: delete it before packaging)');
  } else if (cmd === 'check' || cmd === 'missing') {
    const catalog = readLanguageFile(path.join(LANG_DIR, 'en.js'));
    const codes = cmd === 'missing' || arg ? [arg] : languageCodes();
    let errors = 0;
    for (const code of codes) {
      const file = path.join(LANG_DIR, code + '.js');
      const data = fs.existsSync(file) ? readLanguageFile(file) : { strings: {} };
      if (cmd === 'missing') {
        const miss = Object.keys(catalog.strings).filter((k) => !(data.strings || {})[k]);
        console.log(miss.map((k) => JSON.stringify(k)).join('\n') || '(nothing missing)');
        continue;
      }
      const problems = checkLanguage(code, data, catalog), c = coverage(data, catalog);
      const e = problems.filter((p) => p.level === 'error'), w = problems.filter((p) => p.level === 'warn');
      errors += e.length;
      console.log(`${code.padEnd(6)} ${c.done}/${c.total} translated  ${e.length} errors  ${w.length} warnings`);
      for (const p of [...e, ...w].slice(0, 12)) console.log(`   ${p.level}: ${JSON.stringify(p.key).slice(0, 60)}  ${p.message}`);
    }
    process.exit(errors ? 1 : 0);
  } else console.log('usage: node tools/i18n.js extract | check | missing <code>');
}
