// In the desktop app preload.js exposes window.api (IPC to main.js). When the
// page is opened from dev-server.js in a normal browser we fall back to HTTP.

function toTyped(b64, Ctor) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return Ctor === Uint8Array ? u8 : new Ctor(u8.buffer);
}

function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    if (v.__t) return toTyped(v.b64, { f32: Float32Array, u16: Uint16Array, u8: Uint8Array }[v.__t]);
    const o = {};
    for (const k of Object.keys(v)) o[k] = revive(v[k]);
    return o;
  }
  return v;
}

async function post(route, body) {
  const r = await fetch('/api/' + route, { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'request failed');
  return revive(j);
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = () => resolve(i.files[0] || null);
    i.click();
  });
}

function download(name, href) {
  const a = document.createElement('a');
  a.href = href; a.download = name; a.click();
}

// pop-out 3D window: in the browser harness the two pages talk over a BroadcastChannel
let bc = null;
const chan = () => bc || (bc = new BroadcastChannel('cs-viewer'));

const dev = {
  isDesktop: false,
  setFullscreen: async () => {},
  addVariant: async () => { throw new Error('Adding a texture variant needs the desktop app (the browser test page is read-only).'); },
  deleteVariant: async () => { throw new Error('Deleting a texture variant needs the desktop app (the browser test page is read-only).'); },
  ...Object.fromEntries(['pickYdd', 'registerYdd', 'pickTextures', 'registerTextures', 'fileDataUrl', 'pieceTemplate', 'pieceOptions', 'pieceSetOptions', 'pieceAdd', 'pieceAddTextures', 'pieceDelete', 'pieceMove', 'packNew', 'packBuild']
    .map((n) => [n, async () => { throw new Error('This needs the desktop app (the browser test page is read-only).'); }])),
  ymtStatus: async () => null,
  ymtSync: async () => null,
  viewerOpen: async () => {
    const w = window.open('viewer-window.html', 'cs-viewer-window', 'popup,width=1000,height=800');
    return { reused: false, displays: 1, onOther: false, blocked: !w };
  },
  viewerClose: async () => { chan().postMessage({ type: 'close' }); },
  viewerSend: (msg) => chan().postMessage(msg),
  onViewerMessage: (cb) => { chan().onmessage = (e) => cb(e.data); },
  openPack: async () => {
    const p = new URLSearchParams(location.search).get('pack');
    return p ? post('scan', { path: p }) : null;
  },
  scanPack: (p) => post('scan', { path: p }),
  loadMesh: (p) => post('mesh', { path: p }),
  loadTexture: (p) => post('texture', { path: p }),
  saveTexture: (p, rgba) => {
    let s = '';
    for (let i = 0; i < rgba.length; i += 0x8000) s += String.fromCharCode.apply(null, rgba.subarray(i, i + 0x8000));
    return post('save', { path: p, rgba: btoa(s) });
  },
  savePng: async (name, dataUrl) => { download(name, dataUrl); return name; },
  saveProject: async (name, json) => { download(name, URL.createObjectURL(new Blob([json]))); return name; },
  openProject: async () => { const f = await pickFile('.csproj'); return f ? f.text() : null; },
  openImage: async () => {
    const f = await pickFile('image/*');
    if (!f) return null;
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
  },
  bodyStatus: () => post('bodystatus', {}),
  bodySetDir: async () => null,
  bodyLoad: (gender) => post('body', { gender }),
  onBodyProgress: () => {},
  pathForFile: () => null,
};

export const api = window.api || dev;
