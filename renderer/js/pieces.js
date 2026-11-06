// "Add pieces" dialog: one row per .ydd with what it is (category, male / female, race-specific skin) and its textures.
// The category is pre-filled from the file name when the name says it (jbib_003_u.ydd, mp_f_freemode_01_x^lowr_000_r.ydd);
// otherwise the row asks. The dialog only collects choices - app.js turns them into files.

export const CATEGORIES = {
  Components: [
    ['hand', 'Bags / badges (hand)'], ['jbib', 'Tops / jackets (jbib)'], ['lowr', 'Pants (lowr)'], ['feet', 'Shoes (feet)'],
    ['uppr', 'Torsos / arms (uppr)'], ['accs', 'Undershirts (accs)'], ['task', 'Armor / vests (task)'], ['decl', 'Decals (decl)'],
    ['teef', 'Accessories (teef)'], ['berd', 'Masks (berd)'], ['hair', 'Hair (hair)'], ['head', 'Heads (head)'],
  ],
  'Props (worn items)': [
    ['p_head', 'Hats (p_head)'], ['p_eyes', 'Glasses (p_eyes)'], ['p_ears', 'Ear items (p_ears)'], ['p_mouth', 'Mouth (p_mouth)'],
    ['p_lhand', 'Left hand (p_lhand)'], ['p_rhand', 'Right hand (p_rhand)'], ['p_lwrist', 'Left wrist (p_lwrist)'], ['p_rwrist', 'Right wrist (p_rwrist)'],
    ['p_hip', 'Hip (p_hip)'], ['p_lfoot', 'Left foot (p_lfoot)'], ['p_rfoot', 'Right foot (p_rfoot)'],
    ['p_ph_l_hand', 'Phone, left hand (p_ph_l_hand)'], ['p_ph_r_hand', 'Phone, right hand (p_ph_r_hand)'],
  ],
};
const SKIN_BY_DEFAULT = new Set(['head', 'uppr', 'lowr', 'feet']);   // these are normally race specific (_r)

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

const FLAG_HINTS = {
  HIDE_IN_FIRST_PERSON: 'Hide this piece when the camera is first person.',
  DEFAULT_HELMET: 'Helmet flag (the game treats this prop as the default helmet).', RANDOM_HELMET: 'Helmet flag used by the game for random helmets.',
  SCRIPT_HELMET: 'Helmet flag for scripted helmets.', FLIGHT_HELMET: 'Helmet flag for flight helmets.', PILOT_HELMET: 'Helmet flag for pilot helmets.',
  ARMOURED: 'Counts as armoured clothing.', LIGHTLY_ARMOURED: 'Counts as lightly armoured clothing.',
  NOT_IN_CAR: 'Not shown while the ped is in a car.', BIKE_ONLY: 'Only used on bikes.', NOT_INDOORS: 'Not used indoors.',
};

/**
 * The "Piece options" dialog (audio, flags, render flag, hair scale, high heels, shows skin).
 * data = the reply of api.pieceOptions. Resolves with only the fields that were changed ({} = nothing), or null on Cancel.
 */
export function optionsDialog({ data }) {
  return new Promise((resolve) => {
    const dlg = document.querySelector('#optDlg'), body = document.querySelector('#odBody');
    const ok = document.querySelector('#odOk'), cancel = document.querySelector('#odCancel');
    const o = data.options, isProp = data.prop;
    document.querySelector('#odTitle').textContent = `${data.gender === 'male' ? 'Male' : 'Female'} ${data.label} · options`;
    document.querySelector('#odNote').textContent = 'Saved into the pack\'s .ymt (original kept once as .bak).';
    body.textContent = '';

    const row = (label, control, hint) => {
      const r = el('div', 'od-row');
      r.append(el('label', 'od-label', label), control);
      if (hint) r.append(el('div', 'od-hint', hint));
      body.append(r);
      return r;
    };

    // audio
    const audio = el('select');
    if (o.audio === null) audio.append(Object.assign(el('option', '', `Custom (0x${o.audioHash.toString(16)}) - unchanged`), { value: '__keep' }));
    for (const n of data.audioList) audio.append(Object.assign(el('option', '', n), { value: n }));
    audio.value = o.audio === null ? '__keep' : o.audio;
    row('Audio', audio, isProp ? 'Props have no sound set.' : 'The sound the game plays for this piece (footsteps for shoes, cloth rustle for tops and pants).');

    // shows skin (components only)
    let skin = null;
    if (!isProp) {
      skin = el('input'); skin.type = 'checkbox'; skin.checked = !!o.hasSkin;
      const wrap = el('label', 'od-check'); wrap.append(skin, document.createTextNode(' Shows skin'));
      row('Skin', wrap, 'On for pieces that show the body underneath (pants, shoes, torsos): the files are saved as _r / _whi. Off for tops and bags: _u / _uni. Changing it renames the model and texture files.');
    }

    // render flag (props only)
    let render = null;
    if (isProp) {
      render = el('select');
      for (const n of data.renderFlags) render.append(Object.assign(el('option', '', n), { value: n }));
      render.value = o.renderFlag || data.renderFlags[0];
      row('Render flag', render, 'How the prop is drawn. PRF_ALPHA is the normal setting (and what a prop without a flag already uses); DECAL and CUTOUT are for flat or cut-out props.');
    }

    // flags
    const flagBox = el('div', 'od-flags');
    const known = data.flags.reduce((n, [, v]) => n | v, 0);
    const boxes = data.flags.map(([name, value]) => {
      const lab = el('label', 'od-flag'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = (o.flags & value) !== 0;
      lab.title = `${name} = ${value}${FLAG_HINTS[name] ? ' - ' + FLAG_HINTS[name] : ''}`;
      lab.append(cb, document.createTextNode(' ' + name.toLowerCase().replace(/_/g, ' ')));
      flagBox.append(lab);
      return { cb, value };
    });
    row('Flags', flagBox, 'Extra behaviour switches the game checks. Most pieces use none of them.');
    const flagsNow = () => (o.flags & ~known) | boxes.reduce((n, b) => n | (b.cb.checked ? b.value : 0), 0);

    // hair scale (hats) / high heels (shoes)
    const scale = (key, title, hint, def) => {
      const v = o[key];
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = v.enabled;
      const num = el('input'); num.type = 'number'; num.step = '0.05'; num.min = '0'; num.max = '5'; num.value = String(Math.round((v.value || def) * 1000) / 1000);
      num.disabled = !cb.checked; cb.onchange = () => { num.disabled = !cb.checked; };
      const wrap = el('label', 'od-check'); wrap.append(cb, document.createTextNode(' ' + title + '  '), num);
      row(key === 'hairScale' ? 'Hair' : 'Heels', wrap, hint);
      return { cb, num };
    };
    let hair = null, heels = null;
    if (o.hairScale) hair = scale('hairScale', 'Enable hair scale', 'Squashes the hair underneath the hat so it does not poke through. Smaller number = more squashed. Uses the creature metadata file, which is kept up to date for you.', 0.5);
    if (o.heels) heels = scale('heels', 'Enable high heels', 'Lifts the character so high heels stand on the ground. Higher number = taller heels. Uses the creature metadata file, which is kept up to date for you.', 1);

    const finish = (v) => { dlg.hidden = true; window.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } };
    ok.onclick = () => {
      const out = {};
      if (audio.value !== '__keep' && audio.value !== o.audio) out.audio = audio.value;
      if (skin && skin.checked !== !!o.hasSkin) out.hasSkin = skin.checked;
      if (render && render.value !== (o.renderFlag || data.renderFlags[0])) out.renderFlag = render.value;
      const f = flagsNow(); if (f !== o.flags) out.flags = f;
      for (const [key, ctl] of [['hairScale', hair], ['heels', heels]]) {
        if (!ctl) continue;
        const value = Math.max(0, Number(ctl.num.value) || 0), was = o[key];
        if (ctl.cb.checked !== was.enabled || (ctl.cb.checked && Math.abs(value - was.value) > 1e-6)) out[key] = { enabled: ctl.cb.checked, value };
      }
      finish(out);
    };
    cancel.onclick = () => finish(null);
    window.addEventListener('keydown', onKey, true);
    dlg.hidden = false;
    setTimeout(() => audio.focus(), 0);
  });
}

/**
 * infos: [{ token, name, gender, prop, comp, hasSkin }] from the main process (guesses may be null).
 * Resolves with the confirmed rows [{ info, gender, prop, comp, hasSkin, textures:[{kind,token?,name}] }] or null.
 */
export function addPieceDialog({ api, infos, defaultGender, toast }) {
  return new Promise((resolve) => {
    const dlg = document.querySelector('#pieceDlg'), rowsBox = document.querySelector('#pdRows');
    const ok = document.querySelector('#pdOk'), cancel = document.querySelector('#pdCancel'), more = document.querySelector('#pdMore');
    const rows = [];

    const validate = () => {
      ok.disabled = !rows.length || rows.some((r) => !r.comp || !r.gender);
      for (const r of rows) r.hint.textContent = !r.comp ? 'Choose what this model is.' : r.textures.length ? '' : 'No texture chosen: a plain grey one will be created.';
    };

    const addRow = (info) => {
      const r = {
        info, gender: info.gender || defaultGender || 'male', comp: info.comp || '', prop: !!info.prop,
        hasSkin: info.hasSkin == null ? false : !!info.hasSkin, textures: [],
      };
      if (info.hasSkin == null && r.comp) r.hasSkin = SKIN_BY_DEFAULT.has(r.comp);
      const row = el('div', 'pd-row');
      const head = el('div', 'pd-head');
      head.append(el('b', '', info.name));
      if (!info.comp) head.append(el('span', 'pd-warn', 'The name does not say what this is.'));
      const rm = el('button', 'mini', '✕'); rm.title = 'Do not add this model';
      rm.onclick = () => { rows.splice(rows.indexOf(r), 1); row.remove(); validate(); };
      head.append(rm);

      const form = el('div', 'pd-form');
      const cat = el('select');
      cat.append(Object.assign(el('option', '', '— what is this? —'), { value: '' }));
      for (const [group, list] of Object.entries(CATEGORIES)) {
        const og = el('optgroup'); og.label = group;
        for (const [v, label] of list) og.append(Object.assign(el('option', '', label), { value: v }));
        cat.append(og);
      }
      cat.value = r.comp;
      const gen = el('select');
      for (const g of ['male', 'female']) gen.append(Object.assign(el('option', '', g === 'male' ? 'Male' : 'Female'), { value: g }));
      gen.value = r.gender;
      const skinLabel = el('label', 'pd-skin');
      const skin = el('input'); skin.type = 'checkbox'; skin.checked = r.hasSkin;
      skinLabel.append(skin, document.createTextNode(' Shows skin (race specific)'));
      skinLabel.title = 'Pants, shoes and torsos usually show skin and are saved as _r / _whi. Tops and bags are normally _u / _uni.';
      const sync = () => { skinLabel.hidden = r.comp.startsWith('p_') || !r.comp; };
      cat.onchange = () => {
        r.comp = cat.value; r.prop = r.comp.startsWith('p_');
        if (info.hasSkin == null) { r.hasSkin = SKIN_BY_DEFAULT.has(r.comp); skin.checked = r.hasSkin; }
        sync(); validate();
      };
      gen.onchange = () => { r.gender = gen.value; validate(); };
      skin.onchange = () => { r.hasSkin = skin.checked; };
      form.append(cat, gen, skinLabel);
      sync();

      const tex = el('div', 'pd-tex');
      const list = el('div', 'pd-chips');
      const redraw = () => {
        list.textContent = '';
        r.textures.forEach((t, i) => {
          const c = el('span', 'pd-chip', `${String.fromCharCode(97 + i)}: ${t.name}`);
          const x = el('span', 'pd-x', '✕'); x.onclick = () => { r.textures.splice(i, 1); redraw(); validate(); };
          c.append(x); list.append(c);
        });
        validate();
      };
      const addTex = el('button', 'btn small', 'Add textures…'); addTex.title = 'PNG, JPG, WEBP … or a finished .ytd. Each one becomes the next letter (a, b, c …).';
      addTex.onclick = async () => {
        try { for (const p of await api.pickTextures()) r.textures.push({ kind: p.kind, token: p.token, name: p.name }); redraw(); } catch (e) { toast(String(e.message || e), 'error'); }
      };
      const blank = el('button', 'btn small', 'Blank'); blank.title = 'A plain grey texture to paint on';
      blank.onclick = () => { r.textures.push({ kind: 'blank', name: 'blank grey' }); redraw(); };
      r.hint = el('span', 'pd-hint');
      tex.append(addTex, blank, list, r.hint);

      row.append(head, form, tex);
      rowsBox.append(row);
      rows.push(r);
      validate();
    };

    const finish = (v) => { dlg.hidden = true; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    ok.onclick = () => finish(rows.map((r) => ({ info: r.info, gender: r.gender, prop: r.prop, comp: r.comp, hasSkin: r.hasSkin, textures: r.textures })));
    cancel.onclick = () => finish(null);
    more.onclick = async () => { try { (await api.pickYdd()).forEach(addRow); } catch (e) { toast(String(e.message || e), 'error'); } };

    rowsBox.textContent = '';
    infos.forEach(addRow);
    document.addEventListener('keydown', onKey, true);
    dlg.hidden = false;
  });
}
