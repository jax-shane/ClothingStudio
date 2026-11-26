'use strict';
// Covers the interface languages: renderer/js/i18n.js (t / tn / plurals / language choice), tools/i18n.js (the catalog and the
// checker) and every renderer/lang/<code>.js file.
// i18n.js is an ES module with no imports (the page imports it); for the tests its `export` keywords are dropped and the
// source is evaluated, which works on every Node version the project supports (20 and up). The first test guards that.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tools = require('../tools/i18n');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'i18n.js'), 'utf8');
const EXPORTS = [...SOURCE.matchAll(/^export (?:async )?(?:const|function) (\w+)/gm)].map((m) => m[1]);
let I;
const fresh = () => new Function(SOURCE.replace(/^export /gm, '') + `\nreturn { ${EXPORTS.join(', ')} };`)();
before(() => { I = fresh(); });

describe('the module can be loaded without a browser', () => {
  it('has no imports, and every export is a plain const or function', () => {
    assert.equal(/^import\s/m.test(SOURCE), false, 'i18n.js must stay free of imports');
    assert.equal((SOURCE.match(/^export /gm) || []).length, EXPORTS.length, 'an export that is not `export const` / `export function` would not be loaded by this test');
    for (const n of ['t', 'tn', 'tm', 'list', 'sentences', 'setLanguage', 'getLanguage', 'pickLanguage', 'loadLanguage', 'applyStatic', 'showLanguage', 'startLanguage', 'isRtl', 'LANGUAGES', 'RTL']) assert.ok(EXPORTS.includes(n), n + ' is exported');
  });
});

describe('t()', () => {
  it('shows the English text when there is no translation, and fills {placeholders}', () => {
    I = fresh();
    assert.equal(I.t('Save to YTD'), 'Save to YTD');
    assert.equal(I.t('Saved {name} ({size})', { name: 'a.ytd', size: '1 MB' }), 'Saved a.ytd (1 MB)');
    assert.equal(I.t('Hello {who}'), 'Hello {who}', 'no params: left as they are');
    assert.equal(I.t('Hello {who}', { other: 1 }), 'Hello {who}', 'an unknown placeholder is left as it is');
    assert.equal(I.t('{a} and {a}', { a: 'x' }), 'x and x', 'a placeholder may appear twice');
    assert.equal(I.t('{n} left', { n: 0 }), '0 left', 'zero is a value');
  });
  it('uses the translation of the current language, and English again for an empty one', () => {
    I.setLanguage('de', { strings: { 'Cancel': 'Abbrechen', 'Open pack…': 'Pack öffnen…', 'Saved {name}': 'Gespeichert: {name}', 'Empty': '' } });
    assert.equal(I.getLanguage(), 'de');
    assert.equal(I.t('Cancel'), 'Abbrechen');
    assert.equal(I.t('Saved {name}', { name: 'x' }), 'Gespeichert: x');
    assert.equal(I.t('Empty'), 'Empty');
    assert.equal(I.t('Not translated yet'), 'Not translated yet');
    assert.equal(I.t('toString'), 'toString', 'a key that is a property of Object is not found in the prototype');
    I.setLanguage('en', null);
    assert.equal(I.t('Cancel'), 'Cancel');
  });
});

describe('tn() - texts with a number', () => {
  it('English: one for 1, other for everything else', () => {
    I = fresh();
    assert.equal(I.tn(1, '{n} piece', '{n} pieces'), '1 piece');
    assert.equal(I.tn(0, '{n} piece', '{n} pieces'), '0 pieces');
    assert.equal(I.tn(2, '{n} piece', '{n} pieces'), '2 pieces');
    assert.equal(I.tn(3, '{n} piece in {name}', '{n} pieces in {name}', { name: 'x' }), '3 pieces in x');
  });
  it('a language gives one form per plural category (Russian: one, few, many, other)', () => {
    I.setLanguage('ru', { strings: { '{n} pieces': { one: '{n} деталь', few: '{n} детали', many: '{n} деталей', other: '{n} детали' } } });
    const f = (n) => I.tn(n, '{n} piece', '{n} pieces');
    assert.deepEqual([1, 2, 5, 11, 21, 22, 25, 101].map(f), ['1 деталь', '2 детали', '5 деталей', '11 деталей', '21 деталь', '22 детали', '25 деталей', '101 деталь']);
  });
  it('Arabic has six categories, Japanese one', () => {
    I.setLanguage('ar', { strings: { '{n} pieces': { zero: 'z{n}', one: 'o{n}', two: 't{n}', few: 'f{n}', many: 'm{n}', other: 'x{n}' } } });
    assert.deepEqual([0, 1, 2, 3, 11, 100].map((n) => I.tn(n, '{n} piece', '{n} pieces')), ['z0', 'o1', 't2', 'f3', 'm11', 'x100']);
    I.setLanguage('ja', { strings: { '{n} pieces': { other: '{n}個' } } });
    assert.deepEqual([1, 2].map((n) => I.tn(n, '{n} piece', '{n} pieces')), ['1個', '2個']);
  });
  it('a plain text works for every number, and a missing form falls back to "other" and then to English', () => {
    I.setLanguage('zh-CN', { strings: { '{n} pieces': '{n} 件' } });
    assert.equal(I.tn(1, '{n} piece', '{n} pieces'), '1 件');
    I.setLanguage('de', { strings: { '{n} pieces': { other: '{n} Teile' } } });
    assert.equal(I.tn(1, '{n} piece', '{n} pieces'), '1 Teile');
    I.setLanguage('de', { strings: {} });
    assert.equal(I.tn(1, '{n} piece', '{n} pieces'), '1 piece');
  });
});

describe('tm(), list(), sentences()', () => {
  it('tm() takes a text or { key, params }', () => {
    I = fresh();
    I.setLanguage('de', { strings: { 'Hi {name}': 'Hallo {name}', 'Plain': 'Einfach' } });
    assert.equal(I.tm('Plain'), 'Einfach');
    assert.equal(I.tm({ key: 'Hi {name}', params: { name: 'Jax' } }), 'Hallo Jax');
    assert.equal(I.tm(new Error('boom')), 'Error: boom');
  });
  it('list() writes a list the way the language does', () => {
    I = fresh();
    assert.equal(I.list(['a', 'b', 'c']), 'a, b, and c');
    assert.equal(I.list(['a']), 'a');
    I.setLanguage('de', { strings: {} });
    assert.equal(I.list(['a', 'b', 'c']), 'a, b und c');
  });
  it('sentences() puts a space between sentences, but not in Chinese and Japanese', () => {
    I = fresh();
    assert.equal(I.sentences('One.', 'Two.', '', undefined, 'Three.'), 'One. Two. Three.');
    I.setLanguage('zh-CN', { strings: {} });
    assert.equal(I.sentences('一。', '二。'), '一。二。');
    I.setLanguage('ja', { strings: {} });
    assert.equal(I.sentences('一。', '二。'), '一。二。');
    I.setLanguage('ko', { strings: {} });
    assert.equal(I.sentences('하나.', '둘.'), '하나. 둘.');
  });
});

describe('which language to start in', () => {
  const have = ['en', 'de', 'es', 'pt-br', 'zh-cn', 'zh-tw', 'no', 'he', 'id'];
  it('what the user chose wins, in any letter case', () => {
    assert.equal(I.pickLanguage('de', ['fr-FR'], have), 'de');
    assert.equal(I.pickLanguage('ZH-CN', ['fr-FR'], have), 'zh-cn');
    assert.equal(I.pickLanguage('xx', ['es-MX'], have), 'es', 'a saved language that no longer exists is ignored');
  });
  it('the first language of the system that is available; a region falls back to its language', () => {
    assert.equal(I.pickLanguage(null, ['de-AT', 'en-US'], have), 'de');
    assert.equal(I.pickLanguage(null, ['fr-FR', 'es-ES'], have), 'es', 'French is not available, Spanish is');
    assert.equal(I.pickLanguage(null, ['es_MX'], have), 'es', 'an underscore works too');
  });
  it('Portuguese goes to Brazilian Portuguese, Chinese by script, Norwegian and old codes to the current ones', () => {
    assert.equal(I.pickLanguage(null, ['pt-PT'], have), 'pt-br');
    assert.equal(I.pickLanguage(null, ['pt'], have), 'pt-br');
    assert.equal(I.pickLanguage(null, ['zh-CN'], have), 'zh-cn');
    assert.equal(I.pickLanguage(null, ['zh'], have), 'zh-cn');
    assert.equal(I.pickLanguage(null, ['zh-TW'], have), 'zh-tw');
    assert.equal(I.pickLanguage(null, ['zh-HK'], have), 'zh-tw');
    assert.equal(I.pickLanguage(null, ['zh-Hant'], have), 'zh-tw');
    assert.equal(I.pickLanguage(null, ['nb-NO'], have), 'no');
    assert.equal(I.pickLanguage(null, ['nn'], have), 'no');
    assert.equal(I.pickLanguage(null, ['iw'], have), 'he');
    assert.equal(I.pickLanguage(null, ['in'], have), 'id');
  });
  it('English when nothing fits', () => {
    assert.equal(I.pickLanguage(null, ['sw-KE'], have), 'en');
    assert.equal(I.pickLanguage(null, [], have), 'en');
    assert.equal(I.pickLanguage(), 'en');
  });
  it('right-to-left languages', () => {
    assert.deepEqual(['ar', 'he', 'fa', 'ur', 'ar-SA', 'HE'].map((c) => I.isRtl(c)), [true, true, true, true, true, true]);
    assert.deepEqual(['en', 'de', 'zh-cn', 'ru', 'ja'].map((c) => I.isRtl(c)), [false, false, false, false, false]);
  });
});

describe('the catalog (renderer/lang/en.js)', () => {
  const en = () => tools.readLanguageFile(path.join(tools.LANG_DIR, 'en.js'));

  it('is up to date: it has exactly the texts the code and the pages ask for', () => {
    const { found } = tools.extract();
    const have = Object.keys(en().strings);
    const want = [...found.keys()];
    const missing = want.filter((k) => !have.includes(k)), extra = have.filter((k) => !want.includes(k));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, 'run: node tools/i18n.js extract');
  });

  it('a text with a number is in the catalog with its one and other forms', () => {
    const s = en().strings;
    assert.deepEqual(s['{n} pieces'], { one: '{n} piece', other: '{n} pieces' });
    assert.equal(typeof s['Cancel'], 'string');
  });

  it('every t() / tn() / nt() / T() call in the code has a plain text (or is one of the known tables)', () => {
    const { dynamic } = tools.extract();
    const known = [/t\(message\)/, /t\(label\)/, /t\(b\[1\]\)/, /t\(S\.emptyMsg\)/, /t\(FLAG_HINTS\[name\]\)/, /t\(group\)/, /t\(NAMES\[/, /t\(\)/,
      /t\(KEY_NAME\[k\]\)/, /t\(g\.name\)/, /t\(s\.text\)/, /t\(p\.m\)/,                     // the tables of the keyboard shortcuts (app.js)
      /t\(GRAIN_LABELS\[/];                                                                   // the fabric names of the Fabric look dialog (app.js)
    const unknown = dynamic.filter((d) => !known.some((r) => r.test(d)));
    assert.deepEqual(unknown, [], 'a text for the user must be a plain string so that it can be translated; see docs/TRANSLATING.md');
  });

  it('no text for the user is written without t() where the page shows it (toast, setMsg, askText, confirmBox, .textContent = ...)', () => {
    const sinks = /(?<![\w$.])(toast|setMsg|askText|confirmBox)\(\s*(['"`])(?!\2)/g;
    const problems = [];
    for (const f of ['renderer/js/app.js', 'renderer/js/pieces.js']) {
      const src = tools.stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      for (const m of src.matchAll(sinks)) problems.push(`${f}:${src.slice(0, m.index).split('\n').length}  ${src.slice(m.index, m.index + 60).split('\n')[0]}`);
    }
    assert.deepEqual(problems, [], 'wrap the text: t(\'...\')');
  });
});

describe('the language files', () => {
  const catalog = () => tools.readLanguageFile(path.join(tools.LANG_DIR, 'en.js'));
  const codes = tools.languageCodes().filter((c) => c !== 'pseudo');

  it('every language of the picker has a file, and every file is in the picker', () => {
    const listed = I.LANGUAGES.map((l) => l.code.toLowerCase()).filter((c) => c !== 'en');
    assert.deepEqual([...listed].sort(), [...codes].sort());
    for (const l of I.LANGUAGES) {
      assert.ok(l.name && l.english && l.short, `${l.code} has a name, an English name and a short name`);
      assert.match(l.code, /^[a-z]{2,3}(-[a-z]{2,4})?$/i);
    }
    assert.equal(new Set(I.LANGUAGES.map((l) => l.code.toLowerCase())).size, I.LANGUAGES.length, 'no language twice');
    assert.equal(I.LANGUAGES[0].code, 'en', 'English comes first');
  });

  for (const code of codes) {
    it(`${code}: no errors against the catalog (placeholders, plural forms, ...)`, (t) => {
      const data = tools.readLanguageFile(path.join(tools.LANG_DIR, code + '.js'));
      const problems = tools.checkLanguage(code, data, catalog());
      const errors = problems.filter((p) => p.level === 'error');
      const c = tools.coverage(data, catalog());
      t.diagnostic(`${data.name}: ${c.done} of ${c.total} texts translated, ${problems.length - errors.length} warnings`);
      assert.deepEqual(errors.slice(0, 5), []);
      const entry = I.LANGUAGES.find((l) => l.code.toLowerCase() === code);
      assert.equal(data.name, entry.name, 'the name in the file and in the picker agree');
    });
  }
});

describe('tools/i18n.js', () => {
  const cat = { strings: { 'Cancel': 'Cancel', '{n} pieces': { one: '{n} piece', other: '{n} pieces' }, 'Saved {name} in {file}': 'Saved {name} in {file}', 'Open pack…': 'Open pack…', 'Close': 'Close' } };
  const check = (code, strings, extra = {}) => tools.checkLanguage(code, { name: 'X', dir: 'ltr', strings, ...extra }, cat);
  const errs = (p) => p.filter((x) => x.level === 'error').map((x) => x.key + ' | ' + x.message.split(' ')[0]);

  it('accepts a correct file', () => {
    assert.deepEqual(check('de', { 'Cancel': 'Abbrechen', '{n} pieces': { one: '{n} Teil', other: '{n} Teile' }, 'Saved {name} in {file}': '{file}: {name}', 'Open pack…': 'Öffnen…' }), []);
  });
  it('finds a text that is not in the catalog', () => assert.equal(errs(check('de', { 'Cancle': 'x' })).length, 1));
  it('finds a changed or missing placeholder', () => {
    assert.equal(errs(check('de', { 'Saved {name} in {file}': 'Gespeichert {nam} in {file}' })).length, 1);
    assert.equal(errs(check('de', { 'Saved {name} in {file}': 'Gespeichert in {file}' })).length, 1);
  });
  it('finds a missing or an unknown plural form, using the rules of the language', () => {
    assert.equal(errs(check('ru', { '{n} pieces': { one: 'a', other: 'b' } })).length, 2, 'Russian also needs few and many');
    assert.equal(errs(check('de', { '{n} pieces': { one: 'a', other: 'b', few: 'c' } })).length, 1, 'German has no few');
    assert.deepEqual(errs(check('ja', { '{n} pieces': { other: '{n}個' } })), [], 'Japanese has only other');
    assert.equal(errs(check('de', { '{n} pieces': '{n} x' })).length, 0, 'a plain text is accepted for every number');
  });
  it('finds an empty text and added markup', () => {
    assert.equal(errs(check('de', { 'Cancel': '' })).length, 1);
    assert.equal(errs(check('de', { 'Cancel': '<b>Abbrechen</b>' })).length, 1);
  });
  it('wants dir to be right for the language', () => {
    assert.equal(errs(check('ar', { 'Cancel': 'إلغاء' }, { dir: 'ltr' })).length, 1);
    assert.deepEqual(errs(check('ar', { 'Cancel': 'إلغاء' }, { dir: 'rtl' })), []);
    assert.equal(errs(check('de', { 'Cancel': 'x' }, { dir: 'rtl' })).length, 1);
  });
  it('warns about a text that loses the "…" or is far too long', () => {
    const w = check('de', { 'Open pack…': 'Pack öffnen', 'Close': 'Schließen und alle anderen Fenster und Dialoge ebenfalls beenden' }).filter((x) => x.level === 'warn');
    assert.equal(w.length, 2);
  });

  it('stripComments blanks comments but not strings or regular expressions', () => {
    const src = "const a = t('x'); // t('in a comment')\n/* t('block') */ const re = /['\"]/g; const s = \"// not a comment\"; const q = t('y');\n";
    const out = tools.stripComments(src);
    assert.equal(out.length, src.length);
    assert.equal(out.includes("t('in a comment')"), false);
    assert.equal(out.includes("t('block')"), false);
    assert.equal(out.includes("// not a comment"), true);
    assert.equal(out.includes("t('y')"), true);
    assert.equal(out.split('\n').length, src.split('\n').length, 'line numbers stay');
  });

  it('pseudo() keeps the placeholders and marks the text', () => {
    const p = tools.pseudo('Saved {name} in {file}');
    assert.match(p, /^\[.*\{name\}.*\{file\}.*\]$/);
    assert.notEqual(p.slice(1, 3), 'Sa');
  });
});
