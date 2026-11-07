/* paint.js - a small layered paint engine for the clothing studio.
 * It knows nothing about FiveM: it owns documents (layers, undo), draws with
 * the tools and can flatten / serialise a document. app.js is the UI around it. */
(function (global) {
  'use strict';

  const MAX_UNDO = 25;
  const UNDO_BUDGET = 320 * 1024 * 1024; // bytes of snapshots kept per document
  const BLENDS = [
    ['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'],
    ['overlay', 'Overlay'], ['soft-light', 'Soft light'], ['darken', 'Darken'], ['lighten', 'Lighten'],
  ];

  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const ctxOf = (c) => c.getContext('2d', { willReadFrequently: true });
  const hexRgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgbHex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  const lerp = (a, b, t) => a + (b - a) * t;

  class Layer {
    constructor(w, h, name) {
      this.canvas = mk(w, h);
      this.ctx = ctxOf(this.canvas);
      this.name = name || 'Layer';
      this.visible = true;
      this.opacity = 1;
      this.blend = 'source-over';
      this.locked = false;   // a locked layer cannot be painted on, moved, resized, merged or deleted
      this.text = null;      // live text: the settings the layer's text was painted with, so it can be edited again (cleared as soon as the pixels are changed any other way)
      this.editing = false;  // the text editor has this layer open: it is not drawn meanwhile (the editor shows a preview instead)
      this.autoPaint = null; // set on the layer that paint tools made above a live text layer (so the next stroke reuses it instead of making another)
    }
    clone() {
      const l = new Layer(this.canvas.width, this.canvas.height, this.name);
      l.ctx.drawImage(this.canvas, 0, 0);
      l.visible = this.visible; l.opacity = this.opacity; l.blend = this.blend; l.locked = this.locked;
      l.text = this.text ? JSON.parse(JSON.stringify(this.text)) : null;
      return l;
    }
  }

  class Doc {
    constructor(w, h) {
      this.w = w; this.h = h;
      this.layers = [new Layer(w, h, 'Base')];
      this.active = 0;
      this.undo = []; this.redo = [];
      this.guide = null;     // { canvas, opacity, visible } - shown in the editor only
      this.dirty = false;
    }
  }

  const E = {
    doc: null,
    view: null, vctx: null, overlay: null, octx: null, stroke: null, sctx: null,
    drawing: false,
    carry: 0,
    opts: {
      tool: 'brush', color: '#e03131', size: 28, hardness: 0.85, opacity: 1, symmetry: false,
      tolerance: 24, fill: false,
    },
    handlers: {},
    BLENDS,
  };

  E.on = (evt, fn) => { (E.handlers[evt] = E.handlers[evt] || []).push(fn); };
  const emit = (evt, arg) => (E.handlers[evt] || []).forEach((fn) => fn(arg));

  // ---------------------------------------------------------------- docs
  E.newDoc = (w, h) => new Doc(w, h);

  E.attach = (view, overlay) => {
    E.view = view; E.vctx = view.getContext('2d');
    E.overlay = overlay; E.octx = overlay.getContext('2d');
    E.stroke = mk(1, 1); E.sctx = ctxOf(E.stroke);
  };

  E.setDoc = (doc) => {
    if (E.xf) E.xformEnd(true);          // settle a resize that is still open on the old document
    E.doc = doc;
    for (const c of [E.view, E.overlay, E.stroke]) { c.width = doc.w; c.height = doc.h; }
    E.drawing = false;
    emit('layers'); emit('doc');
    E.render();
  };

  const layer = () => E.doc.layers[E.doc.active];

  // ---------------------------------------------------------------- render
  function composite(g, doc, withStroke) {
    g.clearRect(0, 0, doc.w, doc.h);
    doc.layers.forEach((L, i) => {
      if (!L.visible || L.editing) return;
      g.globalAlpha = L.opacity;
      g.globalCompositeOperation = L.blend;
      g.drawImage(L.canvas, 0, 0);
      if (withStroke && E.drawing && E.strokeLayer === i && E.opts.tool === 'brush') {
        g.globalAlpha = L.opacity * E.opts.opacity;
        g.drawImage(E.stroke, 0, 0);
      }
    });
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  let renderQueued = false;
  E.render = () => {
    if (renderQueued || !E.doc) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const d = E.doc;
      composite(E.vctx, d, true);
      if (d.guide && d.guide.visible) {
        E.vctx.globalAlpha = d.guide.opacity;
        E.vctx.drawImage(d.guide.canvas, 0, 0, d.w, d.h);
        E.vctx.globalAlpha = 1;
      }
    });
  };

  /** Flatten visible layers (no guide). scale < 1 gives a smaller preview. */
  E.flat = (scale, doc) => {
    const d = doc || E.doc; scale = scale || 1;
    const c = mk(Math.max(1, Math.round(d.w * scale)), Math.max(1, Math.round(d.h * scale)));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.scale(scale, scale);
    composite(g, d, false);
    return c;
  };

  /** Flatten into an existing canvas (any size) - used for the live 3D texture. */
  E.flatInto = (target) => {
    const d = E.doc, g = target.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingQuality = 'high';
    g.scale(target.width / d.w, target.height / d.h);
    composite(g, d, true);
    g.setTransform(1, 0, 0, 1, 0, 0);
  };

  /** Replace every pixel of the base layer with decoded texture data (RGBA). */
  E.docFromRGBA = (w, h, rgba, name) => {
    const doc = new Doc(w, h);
    const L = doc.layers[0];
    L.name = name || 'Original';
    L.ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h), 0, 0);
    return doc;
  };

  /** Full-resolution RGBA of the visible result (what gets written to the YTD). */
  E.flatRGBA = (doc) => {
    const d = doc || E.doc, c = E.flat(1, d);
    return c.getContext('2d').getImageData(0, 0, d.w, d.h).data;
  };

  E.flatDataURL = (o) => {
    o = o || {};
    const c = E.flat(o.scale || 1);
    let url = c.toDataURL(o.type || 'image/webp', o.quality == null ? 0.9 : o.quality);
    if ((o.type || 'image/webp') === 'image/webp' && !url.startsWith('data:image/webp')) url = c.toDataURL('image/png');
    return url;
  };

  // ---------------------------------------------------------------- undo
  function trim(d) {
    const per = Math.max(1, d.w * d.h * 4);
    const cap = Math.max(6, Math.min(MAX_UNDO, Math.floor(UNDO_BUDGET / per)));
    while (d.undo.length > cap) d.undo.shift();
  }
  /** Undo point for a pixel change of the active layer. Changing pixels any other way than the text editor turns live text into plain pixels. */
  let skipPx = null;            // a layer that was just created for a stroke: creating it already made the undo point
  function pushPx(keepText) {
    const d = E.doc, L = layer();
    if (skipPx) { const s = skipPx; skipPx = null; if (s === L) { d.dirty = true; return; } }
    d.undo.push({ k: 'px', i: d.active, data: L.ctx.getImageData(0, 0, d.w, d.h), text: L.text });
    if (!keepText) L.text = null;
    trim(d); d.redo.length = 0; d.dirty = true;
  }
  function pushStruct() {
    const d = E.doc;
    d.undo.push({ k: 'st', layers: d.layers.map((l) => l.clone()), active: d.active });
    trim(d); d.redo.length = 0; d.dirty = true;
  }
  function swap(from, to) {
    if (E.xf) E.xformEnd(true);
    const d = E.doc, e = from.pop();
    if (!e) return;
    if (e.k === 'px') {
      const L = d.layers[e.i];
      to.push({ k: 'px', i: e.i, data: L.ctx.getImageData(0, 0, d.w, d.h), text: L.text });
      L.ctx.putImageData(e.data, 0, 0);
      L.text = e.text || null;
    } else {
      to.push({ k: 'st', layers: d.layers, active: d.active });
      d.layers = e.layers; d.active = Math.min(e.active, e.layers.length - 1);
    }
    emit('layers'); emit('change', { final: true }); E.render();
  }
  E.undo = () => swap(E.doc.undo, E.doc.redo);
  E.redo = () => swap(E.doc.redo, E.doc.undo);

  // ---------------------------------------------------------------- layers
  const settle = () => { if (E.xf) E.xformEnd(true); };   // finish an open resize before the layer stack changes

  E.layerOp = {
    add(name) {
      settle();
      const d = E.doc; pushStruct();
      d.layers.splice(d.active + 1, 0, new Layer(d.w, d.h, name || `Layer ${d.layers.length + 1}`));
      d.active += 1; emit('layers'); emit('change', { final: true }); E.render();
    },
    duplicate() {
      settle();
      const d = E.doc; pushStruct();
      const c = layer().clone(); c.name += ' copy';
      d.layers.splice(d.active + 1, 0, c); d.active += 1;
      emit('layers'); emit('change', { final: true }); E.render();
    },
    remove() {
      settle();
      if (layer().locked) { emit('warn', 'That layer is locked. Unlock it first to delete it.'); return; }
      const d = E.doc; pushStruct();
      if (d.layers.length === 1) layer().ctx.clearRect(0, 0, d.w, d.h);
      else { d.layers.splice(d.active, 1); d.active = Math.max(0, d.active - 1); }
      emit('layers'); emit('change', { final: true }); E.render();
    },
    move(dir) {
      settle();
      const d = E.doc, j = d.active + dir;
      if (j < 0 || j >= d.layers.length) return;
      pushStruct();
      [d.layers[d.active], d.layers[j]] = [d.layers[j], d.layers[d.active]];
      d.active = j; emit('layers'); emit('change', { final: true }); E.render();
    },
    mergeDown() {
      settle();
      const d = E.doc;
      if (d.active === 0) return;
      if (layer().locked || d.layers[d.active - 1].locked) { emit('warn', 'A locked layer cannot be merged. Unlock both layers first.'); return; }
      pushStruct();
      const top = layer(), below = d.layers[d.active - 1];
      below.ctx.globalAlpha = top.opacity; below.ctx.globalCompositeOperation = top.blend;
      below.ctx.drawImage(top.canvas, 0, 0);
      below.ctx.globalAlpha = 1; below.ctx.globalCompositeOperation = 'source-over';
      below.text = null;                                 // the layer below now holds more than its text: it becomes plain pixels
      d.layers.splice(d.active, 1); d.active -= 1;
      emit('layers'); emit('change', { final: true }); E.render();
    },
    select(i) { if (i !== E.doc.active) settle(); E.doc.active = i; emit('layers'); },
    set(i, key, value) {
      if (key === 'locked' && value) settle();
      E.doc.layers[i][key] = value; E.doc.dirty = true;
      emit('layers'); emit('change', { final: true }); E.render();
    },
    clear() { settle(); if (layer().locked) { emit('warn', 'The active layer is locked.'); return; } pushPx(); const d = E.doc; layer().ctx.clearRect(0, 0, d.w, d.h); emit('change', { final: true }); E.render(); },
  };

  E.addImageLayer = (source, o) => {
    o = o || {};
    settle();
    const d = E.doc; pushStruct();
    const L = new Layer(d.w, d.h, o.name || 'Image');
    const sw = source.width, sh = source.height;
    if (o.fit === 'stretch') L.ctx.drawImage(source, 0, 0, d.w, d.h);
    else {
      const k = Math.min(d.w / sw, d.h / sh) * (o.maxFraction || 0.6);
      const w = sw * k, h = sh * k;
      L.ctx.drawImage(source, (d.w - w) / 2, (d.h - h) / 2, w, h);
    }
    d.layers.splice(d.active + 1, 0, L); d.active += 1;
    emit('layers'); emit('change', { final: true }); E.render();
  };

  E.setGuide = (source) => {
    const d = E.doc;
    if (!source) { d.guide = null; E.render(); emit('layers'); return; }
    const c = mk(d.w, d.h); c.getContext('2d').drawImage(source, 0, 0, d.w, d.h);
    d.guide = { canvas: c, opacity: 0.5, visible: true };
    emit('layers'); E.render();
  };

  // ---------------------------------------------------------------- tools
  let tipCache = { key: '', canvas: null };
  function tip(size, hardness, color) {
    const d = Math.max(1, Math.ceil(size));
    const key = `${d}|${hardness}|${color}`;
    if (tipCache.key === key) return tipCache.canvas;
    const c = mk(d, d), g = c.getContext('2d'), r = d / 2;
    if (hardness >= 0.99 || d < 3) {
      g.fillStyle = color; g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill();
    } else {
      const [cr, cg, cb] = hexRgb(color);
      const grad = g.createRadialGradient(r, r, r * hardness, r, r, r);
      grad.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
      grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = grad; g.fillRect(0, 0, d, d);
    }
    tipCache = { key, canvas: c };
    return c;
  }

  function stamp(g, x, y, size, color) {
    const t = tip(size, E.opts.hardness, color);
    g.drawImage(t, x - t.width / 2, y - t.height / 2);
    if (E.opts.symmetry) g.drawImage(t, E.doc.w - x - t.width / 2, y - t.height / 2);
  }

  function strokeSegment(g, a, b, color) {
    const sa = E.opts.size * a.p, sb = E.opts.size * b.p;
    const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
    const spacing = Math.max(1, Math.min(sa, sb) * 0.12);
    let d = E.carry;
    while (d <= dist) {
      const f = dist === 0 ? 0 : d / dist;
      stamp(g, a.x + dx * f, a.y + dy * f, lerp(sa, sb, f), color);
      d += spacing;
    }
    E.carry = d - dist;
  }

  function floodFill(x, y) {
    const d = E.doc, L = layer();
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= d.w || y >= d.h) return;
    pushPx();
    const img = L.ctx.getImageData(0, 0, d.w, d.h), px = img.data, w = d.w, h = d.h;
    const i0 = (y * w + x) * 4, tr = px[i0], tg = px[i0 + 1], tb = px[i0 + 2], ta = px[i0 + 3];
    const [fr, fg, fb] = hexRgb(E.opts.color), fa = Math.round(255 * E.opts.opacity), tol = E.opts.tolerance;
    const match = (i) => Math.abs(px[i] - tr) <= tol && Math.abs(px[i + 1] - tg) <= tol
      && Math.abs(px[i + 2] - tb) <= tol && Math.abs(px[i + 3] - ta) <= tol;
    const seen = new Uint8Array(w * h), stack = [x, y];
    while (stack.length) {
      const sy = stack.pop(), sx = stack.pop();
      let xl = sx;
      while (xl >= 0 && !seen[sy * w + xl] && match((sy * w + xl) * 4)) xl--;
      xl++;
      let up = false, down = false;
      for (let xr = xl; xr < w && !seen[sy * w + xr] && match((sy * w + xr) * 4); xr++) {
        const p = sy * w + xr; seen[p] = 1;
        px[p * 4] = fr; px[p * 4 + 1] = fg; px[p * 4 + 2] = fb; px[p * 4 + 3] = fa;
        if (sy > 0) {
          const m = !seen[p - w] && match((p - w) * 4);
          if (m && !up) { stack.push(xr, sy - 1); up = true; } else if (!m) up = false;
        }
        if (sy < h - 1) {
          const m = !seen[p + w] && match((p + w) * 4);
          if (m && !down) { stack.push(xr, sy + 1); down = true; } else if (!m) down = false;
        }
      }
    }
    L.ctx.putImageData(img, 0, 0);
    emit('change', { final: true }); E.render();
  }

  function drawShape(g, tool, a, b, shift) {
    const o = E.opts;
    if (shift) {
      if (tool === 'line') {
        const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        b = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
      } else {
        const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        b = { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s };
      }
    }
    g.save();
    g.globalAlpha = o.opacity; g.lineWidth = o.size; g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = o.color; g.fillStyle = o.color;
    const one = (p, q) => {
      g.beginPath();
      if (tool === 'line') { g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke(); return; }
      if (tool === 'rect') g.rect(Math.min(p.x, q.x), Math.min(p.y, q.y), Math.abs(q.x - p.x), Math.abs(q.y - p.y));
      else g.ellipse((p.x + q.x) / 2, (p.y + q.y) / 2, Math.abs(q.x - p.x) / 2, Math.abs(q.y - p.y) / 2, 0, 0, Math.PI * 2);
      if (o.fill) g.fill(); else g.stroke();
    };
    one(a, b);
    if (o.symmetry) one({ x: E.doc.w - a.x, y: a.y }, { x: E.doc.w - b.x, y: b.y });
    g.restore();
  }

  // ---------------------------------------------------------------- text
  // A text block is described by { text, family, size, bold, italic, align, color, opacity, stroke, strokeColor } and is
  // drawn with its top-left corner at (x, y). The same layout numbers are used for the on-canvas editor, so what you
  // type is what gets painted.
  const quoteFamily = (f) => {
    f = String(f || 'Arial').trim();
    return /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(f) ? f : `"${f.replace(/["\\]/g, '')}"`;
  };
  E.quoteFamily = quoteFamily;
  E.textFont = (o) => `${o.italic ? 'italic ' : ''}${o.bold ? '700 ' : '400 '}${o.size}px ${quoteFamily(o.family)}`;
  const scratchCtx = mk(1, 1).getContext('2d');
  const textOf = (o) => { const s = String(o.text == null ? '' : o.text); return o.caps ? s.toUpperCase() : s; };

  /**
   * Everything about how a text block is laid out, before it is rotated or flipped: the lines, their widths, the line
   * height (size × leading), the block size, and where the baseline sits inside a line.
   * o: { text, family, size, bold, italic, caps, spacing (px between letters), leading (line height ÷ size, default 1.2) }
   */
  E.textLayout = (o, g) => {
    g = g || scratchCtx;
    g.save(); g.font = E.textFont(o); g.letterSpacing = (o.spacing || 0) + 'px';
    const lines = textOf(o).split('\n'), lh = o.size * (o.leading > 0 ? o.leading : 1.2);
    const m = g.measureText('Hg');
    const asc = m.fontBoundingBoxAscent != null ? m.fontBoundingBoxAscent : o.size * 0.8;
    const desc = m.fontBoundingBoxDescent != null ? m.fontBoundingBoxDescent : o.size * 0.2;
    const widths = lines.map((l) => g.measureText(l).width);
    g.restore();
    return { lines, widths, lh, w: Math.max(1, ...widths), h: lines.length * lh, base: (lh - (asc + desc)) / 2 + asc };
  };

  /**
   * Paint a text block with its top-left corner (before rotating) at (x, y). Style fields of o (all optional except text, family, size, color):
   * bold, italic, underline, strike, caps, align, spacing, leading, opacity, stroke + strokeColor (outline), rot (degrees, about the
   * middle of the block), flipH / flipV (mirror the text), shadow + shadowColor / shadowBlur / shadowX / shadowY.
   */
  E.drawText = (g, o, x, y) => {
    const L = E.textLayout(o, g);
    g.save();
    g.globalAlpha = o.opacity == null ? 1 : o.opacity;
    const cx = x + L.w / 2, cy = y + L.h / 2;                       // rotate and mirror about the middle of the block
    g.translate(cx, cy);
    if (o.rot) g.rotate((o.rot * Math.PI) / 180);
    g.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1);
    g.translate(-cx, -cy);
    g.font = E.textFont(o); g.letterSpacing = (o.spacing || 0) + 'px';
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.lineJoin = 'round'; g.miterLimit = 2;
    const shadow = (on) => {
      if (on && o.shadow) { g.shadowColor = o.shadowColor || '#000000'; g.shadowBlur = o.shadowBlur || 0; g.shadowOffsetX = o.shadowX || 0; g.shadowOffsetY = o.shadowY || 0; }
      else { g.shadowColor = 'rgba(0,0,0,0)'; g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0; }
    };
    const thick = Math.max(1, o.size / 16);
    L.lines.forEach((ln, i) => {
      const dx = o.align === 'center' ? (L.w - L.widths[i]) / 2 : o.align === 'right' ? L.w - L.widths[i] : 0;
      const tx = x + dx, by = y + i * L.lh + L.base;
      let casting = true;                                           // only the first thing drawn for a line casts the shadow
      if (o.stroke > 0) { shadow(true); casting = false; g.lineWidth = o.stroke * 2; g.strokeStyle = o.strokeColor || '#000000'; g.strokeText(ln, tx, by); }
      shadow(casting); g.fillStyle = o.color; g.fillText(ln, tx, by);
      shadow(false);
      const lw = Math.max(0, L.widths[i] - (o.spacing || 0));
      if (lw > 0 && o.underline) g.fillRect(tx, by + o.size * 0.09, lw, thick);
      if (lw > 0 && o.strike) g.fillRect(tx, by - o.size * 0.3, lw, thick);
    });
    g.restore();
    return L;
  };

  const layerTitle = (o) => {
    const first = String(o.text).split('\n')[0].trim();
    return 'Text: ' + (first.length > 18 ? first.slice(0, 17) + '…' : first);
  };
  const textMeta = (o, x, y) => Object.assign({}, o, { x, y });

  /** Put new text on its own layer. The layer remembers the settings, so it can be edited again (updateTextLayer). */
  E.addTextLayer = (o, x, y) => {
    if (!String(o.text || '').trim()) return false;
    settle();
    const d = E.doc; pushStruct();
    const L = new Layer(d.w, d.h, layerTitle(o));
    E.drawText(L.ctx, o, x, y);
    L.text = textMeta(o, x, y);
    d.layers.splice(d.active + 1, 0, L); d.active += 1;
    emit('layers'); emit('change', { final: true }); E.render();
    return true;
  };

  /** Hide / show a text layer's own pixels while the editor shows a live preview of it. */
  E.setEditing = (index, on) => {
    const L = E.doc && E.doc.layers[index];
    if (!L) return;
    L.editing = !!on;
    emit('change', { final: false }); E.render();
  };

  /** Re-paint an existing text layer with new text / settings (one undo step). Empty text removes the layer. */
  E.updateTextLayer = (index, o, x, y) => {
    settle();
    const d = E.doc, L = d.layers[index];
    if (!L) return false;
    if (L.locked) { emit('warn', 'That text layer is locked. Unlock it to change the text.'); return false; }
    L.editing = false;
    if (!String(o.text || '').trim()) {                           // all text deleted: the layer goes (Undo brings it back)
      d.active = index; pushStruct();
      d.layers.splice(index, 1); d.active = Math.max(0, Math.min(index, d.layers.length - 1));
      emit('layers'); emit('change', { final: true }); E.render();
      return true;
    }
    const meta = textMeta(o, x, y);
    if (L.text && JSON.stringify(L.text) === JSON.stringify(meta)) { emit('change', { final: true }); E.render(); return true; }   // nothing changed
    d.active = index;
    pushPx(true);
    L.ctx.clearRect(0, 0, d.w, d.h);
    E.drawText(L.ctx, o, x, y);
    L.text = meta;
    if (/^Text: /.test(L.name)) L.name = layerTitle(o);
    emit('layers'); emit('change', { final: true }); E.render();
    return true;
  };

  E.pickAt = (x, y) => {
    const d = E.doc;
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= d.w || y >= d.h) return null;
    const px = E.flat(1).getContext('2d').getImageData(x, y, 1, 1).data;
    if (px[3] === 0) return null;
    return rgbHex(px[0], px[1], px[2]);
  };

  // ---------------------------------------------------------------- live text under the paint, move and resize tools
  // Text layers keep their text as settings (layer.text) so it can be retyped. Anything that rewrites the layer's pixels
  // would lose that, so: brush / line / shapes paint on a layer of their own above the text; Move and Resize change the
  // text settings instead of the pixels (move, scale, turn and mirror all stay live); only erasing, filling and
  // stretching one way only (which text settings cannot express) turn the text into plain pixels.
  const round2 = (v) => Math.round(v * 100) / 100;
  const LENGTHS = ['size', 'spacing', 'stroke', 'shadowBlur', 'shadowX', 'shadowY'];      // the settings that grow with the text
  const sizeOk = (m) => m.size >= 6 && m.size <= 2000;
  function scaledText(m, k) {
    const n = Object.assign({}, m);
    for (const key of LENGTHS) if (typeof n[key] === 'number') n[key] = round2(n[key] * k);
    return n;
  }
  /** the text settings after scaling the block k times about the document point (cx, cy); null when the size would leave 6 - 900 */
  function scaledAround(m, k, cx, cy) {
    const lay = E.textLayout(m), n = scaledText(m, k);
    if (!sizeOk(n)) return null;
    const lay2 = E.textLayout(n);
    n.x = round2(cx + (m.x + lay.w / 2 - cx) * k - lay2.w / 2);
    n.y = round2(cy + (m.y + lay.h / 2 - cy) * k - lay2.h / 2);
    return n;
  }
  const paintLive = (L, m) => { L.ctx.clearRect(0, 0, E.doc.w, E.doc.h); E.drawText(L.ctx, m, m.x, m.y); L.text = m; };

  /** What a finished Resize session does to live text: the text settings that give the same picture, or null if there are none (stretched one way). */
  function liveFromTransform(x) {
    const m0 = x.beforeText;
    if (!m0 || Math.abs(x.sx - x.sy) > 0.01 * Math.max(x.sx, x.sy)) return null;
    const k = (x.sx + x.sy) / 2, n = scaledText(m0, k);
    if (!sizeOk(n)) return null;
    const lay0 = E.textLayout(m0);
    const C0 = { x: m0.x + lay0.w / 2, y: m0.y + lay0.h / 2 };                                  // middle of the text block before
    const rot = (a) => [[Math.cos(a), -Math.sin(a)], [Math.sin(a), Math.cos(a)]];
    const mul = (A, B) => [[A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]], [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]]];
    const F = [[x.fx, 0], [0, x.fy]], F0 = [[m0.flipH ? -1 : 1, 0], [0, m0.flipV ? -1 : 1]];
    const Rho = rot(x.rot);
    const M = mul(mul(mul(Rho, F), rot(((m0.rot || 0) * Math.PI) / 180)), F0);                  // the text's new orientation: a turn, or a turn plus one mirror
    let r1, flip = false;
    if (M[0][0] * M[1][1] - M[0][1] * M[1][0] > 0) r1 = Math.atan2(M[1][0], M[0][0]);
    else { flip = true; r1 = Math.atan2(-M[1][0], -M[0][0]); }
    const v = { x: C0.x - x.home.cx, y: C0.y - x.home.cy };
    const Fv = { x: x.fx * v.x, y: x.fy * v.y };
    const C1 = { x: x.cx + k * (Rho[0][0] * Fv.x + Rho[0][1] * Fv.y), y: x.cy + k * (Rho[1][0] * Fv.x + Rho[1][1] * Fv.y) };   // where the middle of the block ends up
    // the shadow is dragged along with the picture while you resize, so the finished text must put it where the preview showed it
    const sv = { x: x.fx * (m0.shadowX || 0), y: x.fy * (m0.shadowY || 0) };
    n.shadowX = round2(k * (Rho[0][0] * sv.x + Rho[0][1] * sv.y)); n.shadowY = round2(k * (Rho[1][0] * sv.x + Rho[1][1] * sv.y));
    n.rot = round2((((r1 * 180) / Math.PI) % 360 + 540) % 360 - 180);
    n.flipH = flip; n.flipV = false;
    const lay1 = E.textLayout(n);
    n.x = round2(C1.x - lay1.w / 2); n.y = round2(C1.y - lay1.h / 2);
    return n;
  }

  /** The active layer is live text and a brush / line / shape is about to paint: use (or make) a layer of its own just above it. */
  function paintAbove() {
    settle();
    const d = E.doc, t = layer(), up = d.layers[d.active + 1];
    if (up && up.autoPaint === t && up.visible && !up.locked) { d.active += 1; emit('layers'); return; }
    pushStruct();                                                  // creating the layer is the undo step of this first stroke
    const A = new Layer(d.w, d.h, 'Paint over text');
    A.autoPaint = t;
    d.layers.splice(d.active + 1, 0, A); d.active += 1;
    skipPx = A;
    emit('layers');
    emit('note', 'Your painting went on a new layer above the text, so the text can still be edited. (Merge the two layers if you want them as one.)');
  }

  // ---------------------------------------------------------------- pointer API
  let shapeStart = null, moveBase = null, moveStart = null, moveMeta = null;

  E.down = (pt, mods) => {
    const o = E.opts, d = E.doc, p = { x: pt.x, y: pt.y, p: pt.pressure || 1 };
    let L = layer();
    mods = mods || {};
    if (!L.visible && ['brush', 'eraser', 'fill', 'text', 'move'].includes(o.tool)) { emit('warn', 'The active layer is hidden.'); return; }
    if (L.locked && ['brush', 'eraser', 'fill', 'text', 'move', 'line', 'rect', 'ellipse'].includes(o.tool)) { emit('warn', 'The active layer is locked. Unlock it (padlock in the Layers list) to edit it.'); return; }
    skipPx = null;
    if (L.text) {
      if (['brush', 'line', 'rect', 'ellipse'].includes(o.tool)) { paintAbove(); L = layer(); }
      else if (['eraser', 'fill'].includes(o.tool)) emit('note', 'Erasing and filling work on pixels, so the text on this layer became plain pixels. Undo (Ctrl+Z) brings the editable text back.');
    }
    switch (o.tool) {
      case 'brush':
        pushPx();
        E.drawing = true; E.strokeLayer = d.active; E.carry = 0; E.last = p;
        E.sctx.clearRect(0, 0, d.w, d.h);
        strokeSegment(E.sctx, p, p, o.color);
        break;
      case 'eraser':
        pushPx();
        E.drawing = true; E.carry = 0; E.last = p;
        L.ctx.globalCompositeOperation = 'destination-out'; L.ctx.globalAlpha = o.opacity;
        strokeSegment(L.ctx, p, p, '#000000');
        break;
      case 'fill': floodFill(pt.x, pt.y); return;
      case 'eyedrop': { const c = E.pickAt(pt.x, pt.y); if (c) emit('pick', c); return; }
      case 'text': return;                 // the Text tool is handled by the editor in app.js (it types on the canvas)
      case 'line': case 'rect': case 'ellipse':
        E.drawing = true; shapeStart = { x: pt.x, y: pt.y };
        break;
      case 'move':
        E.drawing = true; moveStart = { x: pt.x, y: pt.y };
        if (L.text) { pushPx(true); moveMeta = L.text; break; }            // live text: the text settings move, the text stays editable
        pushPx();
        moveBase = mk(d.w, d.h); moveBase.getContext('2d').drawImage(L.canvas, 0, 0);
        break;
      default: return;
    }
    emit('change', { final: false }); E.render();
  };

  E.move = (pt, mods) => {
    if (!E.drawing) return;
    const o = E.opts, d = E.doc, L = layer(), p = { x: pt.x, y: pt.y, p: pt.pressure || 1 };
    switch (o.tool) {
      case 'brush': strokeSegment(E.sctx, E.last, p, o.color); E.last = p; break;
      case 'eraser': strokeSegment(L.ctx, E.last, p, '#000000'); E.last = p; break;
      case 'line': case 'rect': case 'ellipse':
        E.octx.clearRect(0, 0, d.w, d.h);
        drawShape(E.octx, o.tool, shapeStart, { x: pt.x, y: pt.y }, mods && mods.shift);
        return;
      case 'move':
        if (moveMeta) { paintLive(L, Object.assign({}, moveMeta, { x: moveMeta.x + Math.round(pt.x - moveStart.x), y: moveMeta.y + Math.round(pt.y - moveStart.y) })); break; }
        L.ctx.clearRect(0, 0, d.w, d.h);
        L.ctx.drawImage(moveBase, Math.round(pt.x - moveStart.x), Math.round(pt.y - moveStart.y));
        break;
      default: return;
    }
    emit('change', { final: false }); E.render();
  };

  E.up = (pt, mods) => {
    if (!E.drawing) return;
    const o = E.opts, d = E.doc, L = layer();
    switch (o.tool) {
      case 'brush':
        L.ctx.save(); L.ctx.globalAlpha = o.opacity; L.ctx.drawImage(E.stroke, 0, 0); L.ctx.restore();
        E.sctx.clearRect(0, 0, d.w, d.h);
        break;
      case 'eraser':
        L.ctx.globalCompositeOperation = 'source-over'; L.ctx.globalAlpha = 1;
        break;
      case 'line': case 'rect': case 'ellipse':
        pushPx();
        E.octx.clearRect(0, 0, d.w, d.h);
        drawShape(L.ctx, o.tool, shapeStart, { x: pt.x, y: pt.y }, mods && mods.shift);
        shapeStart = null;
        break;
      case 'move': moveBase = null; moveMeta = null; break;
      default: break;
    }
    skipPx = null;
    E.drawing = false;
    emit('change', { final: true }); E.render();
  };

  let lastScaleUndo = 0;
  /** Scale the active layer's pixels around (cx, cy) - used by the Move tool's wheel. */
  E.scaleActive = (factor, cx, cy) => {
    const d = E.doc, L = layer();
    if (!L.visible) return;
    if (L.locked) { emit('warn', 'The active layer is locked.'); return; }
    const now = performance.now();
    if (L.text) {                                                      // live text: scale the text itself, it stays editable
      const n = scaledAround(L.text, factor, cx, cy);
      if (!n) { emit('warn', 'The text cannot get any bigger or smaller than that.'); return; }
      if (now - lastScaleUndo > 600) pushPx(true);
      lastScaleUndo = now;
      paintLive(L, n);
      emit('change', { final: true }); E.render();
      return;
    }
    if (now - lastScaleUndo > 600) pushPx();
    lastScaleUndo = now;
    const copy = mk(d.w, d.h); copy.getContext('2d').drawImage(L.canvas, 0, 0);
    L.ctx.clearRect(0, 0, d.w, d.h);
    L.ctx.save(); L.ctx.translate(cx, cy); L.ctx.scale(factor, factor); L.ctx.translate(-cx, -cy);
    L.ctx.imageSmoothingQuality = 'high'; L.ctx.drawImage(copy, 0, 0); L.ctx.restore();
    emit('change', { final: true }); E.render();
  };

  E.isDrawing = () => E.drawing;

  // ---------------------------------------------------------------- free transform (resize / rotate / flip a layer)
  // A session keeps the layer's original pixels (cropped to what is actually drawn) and re-renders them
  // from scratch on every change, so scaling up and down never compounds blur. The result is baked into
  // the layer as one undo step when the session ends.
  function alphaBounds(canvas) {
    const w = canvas.width, h = canvas.height;
    const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4 + 3;
      let first = -1, last = -1;
      for (let x = 0; x < w; x++) if (px[row + x * 4]) { if (first < 0) first = x; last = x; }
      if (first >= 0) { if (first < x0) x0 = first; if (last > x1) x1 = last; if (y < y0) y0 = y; y1 = y; }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  E.xf = null;

  /** Start resizing the active layer. Returns false if there is nothing to resize (empty, hidden or locked). */
  E.xformBegin = () => {
    const d = E.doc;
    if (!d) return false;
    if (E.xf) return true;
    const L = layer();
    if (!L.visible || L.locked) return false;
    const b = alphaBounds(L.canvas);
    if (!b) return false;
    const src = mk(b.w, b.h);
    src.getContext('2d').drawImage(L.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    E.xf = {
      layerIndex: d.active, src, bw: b.w, bh: b.h,
      home: { cx: b.x + b.w / 2, cy: b.y + b.h / 2 },
      cx: b.x + b.w / 2, cy: b.y + b.h / 2, sx: 1, sy: 1, rot: 0, fx: 1, fy: 1,
      before: L.ctx.getImageData(0, 0, d.w, d.h), beforeText: L.text, wasDirty: d.dirty, changed: false,
    };
    emit('xform');
    return true;
  };

  E.xformState = () => {
    const x = E.xf;
    return x && {
      layerIndex: x.layerIndex, bw: x.bw, bh: x.bh, cx: x.cx, cy: x.cy, sx: x.sx, sy: x.sy,
      rot: x.rot, fx: x.fx, fy: x.fy, changed: x.changed, home: x.home,
    };
  };

  function xfPaint(final) {
    const x = E.xf, d = E.doc, g = d.layers[x.layerIndex].ctx;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, d.w, d.h);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.translate(x.cx, x.cy); g.rotate(x.rot); g.scale(x.sx * x.fx, x.sy * x.fy);
    g.drawImage(x.src, -x.bw / 2, -x.bh / 2);
    g.restore();
    emit('change', { final: !!final }); E.render(); emit('xform');
  }

  /** patch: any of cx, cy, sx, sy, rot, fx, fy. final=true also refreshes thumbnails etc. */
  E.xformSet = (patch, final) => {
    const x = E.xf;
    if (!x) return;
    for (const k of ['cx', 'cy', 'sx', 'sy', 'rot', 'fx', 'fy']) if (patch[k] !== undefined && isFinite(patch[k])) x[k] = patch[k];
    x.sx = Math.max(0.005, x.sx); x.sy = Math.max(0.005, x.sy);
    x.changed = true; E.doc.dirty = true;
    xfPaint(final);
  };

  /** apply=true bakes the result in (one undo step); false puts the layer back exactly as it was. */
  E.xformEnd = (apply) => {
    const x = E.xf;
    if (!x) return;
    const d = E.doc, L = d.layers[x.layerIndex];
    E.xf = null;
    if (x.changed) {
      if (apply) {
        d.undo.push({ k: 'px', i: x.layerIndex, data: x.before, text: x.beforeText }); trim(d); d.redo.length = 0; d.dirty = true;
        L.text = null;
        if (x.beforeText) {                                            // live text: move, scale, turn and mirror keep it live and sharp (painted again, not resampled)
          const m = liveFromTransform(x);
          if (m) paintLive(L, m);
          else emit('note', 'That resize turned the text into plain pixels (text settings cannot stretch it one way only, or make it smaller than 6 or bigger than 2000), so it can no longer be retyped. Undo (Ctrl+Z) brings the editable text back.');
        }
      }
      else { L.ctx.putImageData(x.before, 0, 0); d.dirty = x.wasDirty; }
      emit('change', { final: true }); E.render();
    }
    emit('xform');
  };

  // ---------------------------------------------------------------- save / load
  E.serialize = (doc) => {
    doc = doc || E.doc;
    return {
      v: 1, w: doc.w, h: doc.h, active: doc.active,
      layers: doc.layers.map((L) => ({
        name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend, locked: !!L.locked,
        text: L.text || undefined,
        src: L.canvas.toDataURL('image/webp', 0.92),
      })),
    };
  };

  const loadImg = (src) => new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image failed to load')); i.src = src;
  });
  E.loadImage = loadImg;

  /** Rebuild a Doc from serialize() output. If the saved size differs it is rescaled to (w, h). */
  E.deserialize = async (obj, w, h) => {
    w = w || obj.w; h = h || obj.h;
    const doc = new Doc(w, h);
    doc.layers = [];
    for (const l of obj.layers) {
      const L = new Layer(w, h, l.name);
      L.visible = l.visible !== false; L.opacity = l.opacity == null ? 1 : l.opacity; L.blend = l.blend || 'source-over'; L.locked = !!l.locked;
      L.ctx.drawImage(await loadImg(l.src), 0, 0, w, h);
      if (l.text && typeof l.text === 'object' && w === obj.w && h === obj.h) L.text = l.text;   // a rescaled project keeps the pixels but not the editable text
      doc.layers.push(L);
    }
    if (!doc.layers.length) doc.layers.push(new Layer(w, h, 'Base'));
    doc.active = Math.min(obj.active || 0, doc.layers.length - 1);
    return doc;
  };

  E.util = { hexRgb, rgbHex, mk };
  global.Paint = E;
})(window);
