'use strict';
// Runs the (CPU heavy) archive reading off the main thread so the window never freezes.
const { parentPort } = require('worker_threads');
const { BodySource } = require('./body');

let source = null;

parentPort.on('message', (msg) => {
  try {
    if (msg.type === 'load') {
      if (!source || source.gtaDir !== msg.gtaDir) source = new BodySource(msg.gtaDir, msg.keyCache);
      const data = source.load(msg.gender, (text) => parentPort.postMessage({ type: 'progress', id: msg.id, text }));
      parentPort.postMessage({ type: 'result', id: msg.id, data });
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: String(e && e.message || e) });
  }
});
