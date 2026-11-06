// The pop-out 3D window. It owns no documents: the editor window pushes the scene
// ('state') and the live texture pixels ('tex') over api.viewerSend / api.onViewerMessage.
import { api } from './api.js';
import { Viewer } from './viewer.js';

const $ = (s) => document.querySelector(s);
const viewer = new Viewer($('#stage'));

let texCanvas = null;       // the texture the editor streams into
let hasBody = false;        // body data received
let bodyWanted = true;      // the editor wants the body shown
let bodyLocal = true;       // the Body button in this window

function ensureTex(w, h) {
  if (texCanvas && texCanvas.width === w && texCanvas.height === h) return;
  texCanvas = document.createElement('canvas');
  texCanvas.width = w; texCanvas.height = h;
  viewer.setTextureCanvas(texCanvas);
}

function showBody() {
  const on = hasBody && bodyWanted && bodyLocal;
  viewer.showBody(on);
  $('#pBody').classList.toggle('on', bodyLocal);
}

function onMessage(m) {
  if (!m) return;
  if (m.type === 'state') {
    if (m.body !== undefined) { viewer.setBody(m.body); hasBody = !!m.body; }
    bodyWanted = !!m.bodyOn;
    showBody();
    viewer.hideBodyParts(new Set(m.hide || []));
    viewer.setMesh(m.mesh, !!m.isProp, m.bone || null);
    $('#plabel').textContent = m.label || '';
  } else if (m.type === 'label') {
    $('#plabel').textContent = m.label || '';
  } else if (m.type === 'tex') {
    ensureTex(m.width, m.height);
    const px = new Uint8ClampedArray(m.rgba.buffer, m.rgba.byteOffset, m.rgba.byteLength);
    texCanvas.getContext('2d').putImageData(new ImageData(px, m.width, m.height), 0, 0);
    viewer.refresh();
  } else if (m.type === 'close') {
    window.close();
  }
}

let isFull = false;
function setFull(on) {
  isFull = !!on;
  api.setFullscreen(isFull).catch(() => { /* ignore */ });
  if (isFull && !window.api) document.documentElement.requestFullscreen().catch(() => { /* browser harness only */ });
  $('#pFull').classList.toggle('on', isFull);
  $('#pFull').textContent = isFull ? 'Exit full screen' : 'Full screen';
}
const toggleFullscreen = () => setFull(!isFull);

$('#pReset').onclick = () => viewer.frame();
$('#pWire').onclick = (e) => { e.currentTarget.classList.toggle('on'); viewer.setWireframe(e.currentTarget.classList.contains('on')); };
$('#pBack').onclick = () => viewer.toggleBackground();
$('#pBody').onclick = () => { bodyLocal = !bodyLocal; showBody(); };
$('#pFull').onclick = toggleFullscreen;
$('#stage').addEventListener('dblclick', toggleFullscreen);
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.key === 'F11' || k === 'f') { e.preventDefault(); toggleFullscreen(); }
  else if (e.key === 'Escape' && isFull) setFull(false);
  else if (k === 'r') viewer.frame();
  else if (k === 'w') $('#pWire').click();
  else if (k === 'b') $('#pBack').click();
});

// the toolbar stays faint until the mouse moves
let idle = null;
window.addEventListener('mousemove', () => {
  document.body.classList.add('active');
  clearTimeout(idle);
  idle = setTimeout(() => document.body.classList.remove('active'), 2500);
});

window.addEventListener('pagehide', () => api.viewerSend({ type: 'closed' }));

window.__pop = { viewer, tex: () => texCanvas };   // debug handle used by the smoke test
api.onViewerMessage(onMessage);
api.viewerSend({ type: 'ready' });   // the editor answers with the current scene
