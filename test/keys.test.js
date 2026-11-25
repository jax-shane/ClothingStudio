'use strict';
// Covers renderer/js/keys.js: how a key press is spelled for the shortcut table of app.js ("Ctrl+Shift+S", "Alt+]", "PageDown").
// The file is an ES module with no imports, so its `export` keywords are dropped and the source is evaluated (Node 20 and up).

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'keys.js'), 'utf8');
const EXPORTS = [...SOURCE.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
let K;
before(() => { K = new Function(SOURCE.replace(/^export /gm, '') + `\nreturn { ${EXPORTS.join(', ')} };`)(); });

/** a keydown event as the browser makes it */
const ev = (key, code, mods = {}) => ({ key, code, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta, getModifierState: (m) => m === 'AltGraph' && !!mods.altGr });

describe('the module can be loaded without a browser', () => {
  it('has no imports, and every export is a plain const or function', () => {
    assert.equal(/^import\s/m.test(SOURCE), false);
    assert.equal((SOURCE.match(/^export /gm) || []).length, EXPORTS.length);
    assert.deepEqual([...EXPORTS].sort(), ['comboOf', 'digitOf', 'shortcutMatches']);
  });
});

describe('comboOf', () => {
  it('letters in upper case, modifiers in the order Ctrl, Alt, Shift', () => {
    assert.equal(K.comboOf(ev('b', 'KeyB')), 'B');
    assert.equal(K.comboOf(ev('o', 'KeyO', { ctrl: true })), 'Ctrl+O');
    assert.equal(K.comboOf(ev('S', 'KeyS', { ctrl: true, shift: true })), 'Ctrl+Shift+S');
    assert.equal(K.comboOf(ev('n', 'KeyN', { ctrl: true, shift: true, alt: true })), 'Ctrl+Alt+Shift+N');
    assert.equal(K.comboOf(ev('d', 'KeyD', { meta: true })), 'Ctrl+D', 'the Mac command key counts as Ctrl');
  });
  it('named keys keep their names', () => {
    assert.equal(K.comboOf(ev('PageDown', 'PageDown')), 'PageDown');
    assert.equal(K.comboOf(ev('PageUp', 'PageUp', { ctrl: true })), 'Ctrl+PageUp');
    assert.equal(K.comboOf(ev('F2', 'F2')), 'F2');
    assert.equal(K.comboOf(ev('Delete', 'Delete')), 'Delete');
    assert.equal(K.comboOf(ev('Del', 'Delete')), 'Delete', 'the old spelling');
    assert.equal(K.comboOf(ev(' ', 'Space')), 'Space');
    assert.equal(K.comboOf(ev('Esc', 'Escape')), 'Escape');
  });
  it('Shift with a bracket or the = key is spelled with the key itself, as on the key cap', () => {
    assert.equal(K.comboOf(ev('{', 'BracketLeft', { shift: true })), 'Shift+[');
    assert.equal(K.comboOf(ev('}', 'BracketRight', { shift: true })), 'Shift+]');
    assert.equal(K.comboOf(ev('+', 'Equal', { ctrl: true, shift: true })), 'Ctrl+Shift+=');
    assert.equal(K.comboOf(ev('?', 'Slash', { shift: true })), 'Shift+/');
  });
  it('a character another layout makes with Shift is not turned into a US key', () => {
    assert.equal(K.comboOf(ev('?', 'Minus', { shift: true })), 'Shift+?', 'German: ? is Shift+ß');
    assert.equal(K.comboOf(ev('*', 'BracketRight', { shift: true })), 'Shift+*', 'German: * is Shift on the + key');
  });
  it('plus on the number pad and on a German keyboard zoom in like Ctrl+=', () => {
    assert.equal(K.comboOf(ev('+', 'NumpadAdd', { ctrl: true })), 'Ctrl+=');
    assert.equal(K.comboOf(ev('+', 'BracketRight', { ctrl: true })), 'Ctrl++');
    assert.equal(K.comboOf(ev('-', 'Minus', { ctrl: true })), 'Ctrl+-');
    assert.equal(K.comboOf(ev('-', 'NumpadSubtract', { ctrl: true })), 'Ctrl+-');
  });
  it('AltGr (Ctrl+Alt on Windows) types a character: "[" on a German keyboard is just "["', () => {
    assert.equal(K.comboOf(ev('[', 'Digit8', { ctrl: true, alt: true, altGr: true })), '[');
    assert.equal(K.comboOf(ev(']', 'Digit9', { ctrl: true, alt: true, altGr: true })), ']');
  });
});

describe('shortcutMatches and digitOf', () => {
  it('a table entry matches one of its keys, or its own test', () => {
    const save = { keys: ['Ctrl+S'] }, redo = { keys: ['Ctrl+Y', 'Ctrl+Shift+Z'] }, help = { keys: ['F1'], match: (e) => e.key === '?' };
    assert.equal(K.shortcutMatches(save, ev('s', 'KeyS', { ctrl: true })), true);
    assert.equal(K.shortcutMatches(save, ev('s', 'KeyS')), false);
    assert.equal(K.shortcutMatches(save, ev('S', 'KeyS', { ctrl: true, shift: true })), false, 'Ctrl+Shift+S is another shortcut');
    assert.equal(K.shortcutMatches(redo, ev('Z', 'KeyZ', { ctrl: true, shift: true })), true);
    assert.equal(K.shortcutMatches(help, ev('?', 'Minus', { shift: true })), true, 'the ? of any keyboard');
    assert.equal(K.shortcutMatches(help, ev('F1', 'F1')), true);
  });
  it('digitOf reads the number keys by position, so AZERTY keyboards work without Shift', () => {
    assert.equal(K.digitOf(ev('1', 'Digit1')), 1);
    assert.equal(K.digitOf(ev('&', 'Digit1')), 1, 'French keyboard: the 1 key types &');
    assert.equal(K.digitOf(ev('0', 'Digit0')), 10);
    assert.equal(K.digitOf(ev('5', 'Numpad5')), 5);
    assert.equal(K.digitOf(ev('1', 'Digit1', { ctrl: true })), null, 'Ctrl+1 is another shortcut');
    assert.equal(K.digitOf(ev('a', 'KeyA')), null);
  });
});
