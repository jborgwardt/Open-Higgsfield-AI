import '../styles/engine.css';
import '../styles/tools.css';
import { engine } from '../lib/engine.js';

/**
 * Tools / Apps page. Everything here is rendered from the engine's server-side registry (GET /engine/api/tools) —
 * the same schema the Apple app renders — so a tool is added or fixed by editing engine/lib/tools.js only.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACCEPT = { image: 'image/*', video: 'video/*', audio: 'audio/*' };
const ICON = { Cinema: '🎬', Effects: '✨', 'Ads & Products': '🛍️', Video: '🎞️', Image: '🖼️', 'Face & Identity': '🧑', 'Speak & Audio': '🎙️' };

export function ToolsPage() {
    const root = document.createElement('div');
    root.className = 'eg tl';
    root.innerHTML = '<div class="tl-load muted"><span class="spin"></span> Loading tools…</div>';

    const S = { tools: [], cat: 'All', q: '', tool: null, values: {}, media: null, characters: null, runs: JSON.parse(localStorage.getItem('tools_runs') || '[]') };

    async function load() {
        try {
            S.tools = await engine.get('/tools');
        } catch (e) {
            root.innerHTML = `<div class="tl-load">${esc(engine.online ? `Could not load tools: ${e.message}` : 'Tools need the studio engine (engine/server.js).')}</div>`;
            return;
        }
        const want = new URLSearchParams(location.hash.slice(1)).get('tool');
        render();
        if (want && S.tools.some((t) => t.id === want)) openTool(want);
    }

    /* ---------------- layout ---------------- */

    function render() {
        const cats = ['All', ...new Set(S.tools.map((t) => t.category))];
        root.innerHTML = `
          <aside class="tl-side">
            <h2>Tools</h2>
            <input type="text" class="tl-search" placeholder="Search ${S.tools.length} tools…" value="${esc(S.q)}" />
            <nav class="tl-cats">${cats.map((c) => `<button data-cat="${esc(c)}" class="${c === S.cat ? 'on' : ''}">${ICON[c] || '◻︎'} ${esc(c)}<span>${c === 'All' ? S.tools.length : S.tools.filter((t) => t.category === c).length}</span></button>`).join('')}</nav>
          </aside>
          <section class="tl-main"></section>`;
        root.querySelector('.tl-search').oninput = (e) => { S.q = e.target.value; renderMain(); };
        root.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { S.cat = b.dataset.cat; S.tool = null; render(); }));
        renderMain();
    }

    function renderMain() {
        const main = root.querySelector('.tl-main');
        if (S.tool) return renderTool(main);
        const q = S.q.trim().toLowerCase();
        const list = S.tools.filter((t) => (S.cat === 'All' || t.category === S.cat) && (!q || `${t.title} ${t.description} ${t.category}`.toLowerCase().includes(q)));
        const groups = [...new Set(list.map((t) => t.category))];
        main.innerHTML = groups.map((g) => `
          <h3 class="tl-h">${ICON[g] || ''} ${esc(g)}</h3>
          <div class="tl-grid">${list.filter((t) => t.category === g).map((t) => `
            <button class="tl-card" data-tool="${esc(t.id)}">
              <b>${esc(t.title)}</b><span>${esc(t.description)}</span><i>${esc(t.output)}</i>
            </button>`).join('')}</div>`).join('') || '<div class="tl-load muted">No tools match.</div>';
        main.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => openTool(b.dataset.tool)));
    }

    function openTool(id) {
        S.tool = S.tools.find((t) => t.id === id);
        S.values = Object.fromEntries(S.tool.inputs.filter((i) => i.default !== undefined && i.default !== '').map((i) => [i.key, i.default]));
        history.replaceState(null, '', `#tool=${id}`);
        renderMain();
        root.querySelector('.tl-main').scrollTop = 0;
    }

    /* ---------------- tool form ---------------- */

    function field(i) {
        const v = S.values[i.key];
        const label = `<span>${esc(i.label)}${i.required ? ' <em class="req">required</em>' : ''}${i.help ? `<em>${esc(i.help)}</em>` : ''}</span>`;
        switch (i.type) {
            case 'longtext': return `<label class="f">${label}<textarea data-k="${i.key}" rows="3">${esc(v ?? '')}</textarea></label>`;
            case 'text': return `<label class="f">${label}<input type="text" data-k="${i.key}" value="${esc(v ?? '')}" /></label>`;
            case 'number': return `<label class="f">${label}<input type="number" data-k="${i.key}" value="${esc(v ?? '')}" ${i.min != null ? `min="${i.min}"` : ''} ${i.max != null ? `max="${i.max}"` : ''} /></label>`;
            case 'toggle': return `<label class="toggle tl-tog"><input type="checkbox" data-k="${i.key}" ${v ? 'checked' : ''}/> ${esc(i.label)}</label>`;
            case 'select': case 'model': case 'voice': {
                const o = i.options || [];
                if (!o.length) return `<label class="f">${label}<select data-k="${i.key}" disabled><option>${i.type === 'voice' ? 'Default voice' : 'Nothing connected'}</option></select></label>`;
                return `<label class="f">${label}<select data-k="${i.key}">${i.type !== 'select' ? `<option value="">Auto (best connected)</option>` : ''}${o.map((x) => `<option value="${esc(x.value)}" ${String(x.value) === String(v ?? '') ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>`;
            }
            case 'character': {
                const list = S.characters || [];
                return `<label class="f">${label}<select data-k="${i.key}" ${list.length ? '' : 'disabled'}><option value="">${list.length ? '— none —' : 'No saved characters'}</option>${list.map((c) => `<option value="${esc(c.id)}" ${c.id === v ? 'selected' : ''}>${esc(c.name || c.id)}</option>`).join('')}</select></label>`;
            }
            case 'image': case 'video': case 'audio': {
                const url = v ? (typeof v === 'string' ? v : v.url) : '';
                const prev = !url ? `<div class="ph">${i.type === 'image' ? '＋ Image' : i.type === 'video' ? '＋ Video' : '＋ Audio'}</div>`
                    : i.type === 'image' ? `<img src="${esc(url)}" />` : i.type === 'video' ? `<video src="${esc(url)}" muted playsinline></video>` : `<audio src="${esc(url)}" controls></audio>`;
                return `<div class="f tl-media" data-media="${i.key}">${label}
                    <div class="tl-drop ${url ? 'has' : ''}" data-pick="${i.key}">${prev}</div>
                    <div class="row tl-mbtns">
                      <button type="button" class="btn sm" data-pick="${i.key}">Upload</button>
                      ${i.type !== 'audio' ? `<button type="button" class="btn sm" data-lib="${i.key}">Library</button>` : ''}
                      ${i.annotate && (i.annotate === 'mask' ? S.values.image : url) ? `<button type="button" class="btn sm primary" data-draw="${i.key}">${i.annotate === 'mask' ? 'Paint mask on image' : 'Draw'}</button>` : ''}
                      ${url ? `<button type="button" class="btn sm ghost" data-clear="${i.key}">✕</button>` : ''}
                    </div>
                    <div class="tl-lib" data-libfor="${i.key}"></div>
                  </div>`;
            }
            default: return '';
        }
    }

    function renderTool(main) {
        const t = S.tool;
        if (t.inputs.some((i) => i.type === 'character') && S.characters === null) {
            S.characters = [];
            engine.get('/characters').then((r) => { S.characters = Array.isArray(r) ? r : r.characters || []; if (S.tool === t) renderTool(main); }).catch(() => {});
        }
        const runs = S.runs.filter((r) => r.tool === t.id).slice(0, 12);
        main.innerHTML = `
          <div class="tl-top"><button class="btn ghost sm" data-back>← All tools</button><span class="chip">${esc(t.category)}</span></div>
          <div class="tl-tool">
            <form class="tl-form card col">
              <h2>${esc(t.title)}</h2>
              <p class="muted">${esc(t.description)}</p>
              <div class="tl-fields">${t.inputs.map(field).join('')}</div>
              <div class="row"><button class="btn primary tl-go" type="submit">Generate ${esc(t.output)}</button><span class="muted tl-status"></span></div>
            </form>
            <div class="tl-out">
              <div class="tl-result card"><div class="ph muted">Your ${esc(t.output)} appears here.</div></div>
              ${runs.length ? `<h3 class="tl-h">Recent</h3><div class="tl-recent">${runs.map((r) => thumb(r)).join('')}</div>` : ''}
            </div>
          </div>`;
        main.querySelector('[data-back]').onclick = () => { S.tool = null; history.replaceState(null, '', location.pathname); renderMain(); };
        const form = main.querySelector('form');
        form.addEventListener('input', (e) => {
            const k = e.target.dataset.k;
            if (!k) return;
            S.values[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        });
        form.addEventListener('change', (e) => { const k = e.target.dataset.k; if (k) S.values[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; });
        form.onsubmit = (e) => { e.preventDefault(); run(main); };
        main.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => pickFile(b.dataset.pick, main)));
        main.querySelectorAll('[data-clear]').forEach((b) => (b.onclick = () => { delete S.values[b.dataset.clear]; renderTool(main); }));
        main.querySelectorAll('[data-lib]').forEach((b) => (b.onclick = () => showLibrary(b.dataset.lib, main)));
        main.querySelectorAll('[data-draw]').forEach((b) => (b.onclick = () => annotate(b.dataset.draw, main)));
        main.querySelectorAll('.tl-recent [data-url]').forEach((el) => (el.onclick = () => showResult(main, S.runs.find((r) => r.url === el.dataset.url))));
    }

    const thumb = (r) => `<div class="tl-th" data-url="${esc(r.url)}">${r.kind === 'video' ? `<video src="${esc(r.url)}" muted preload="metadata"></video>` : r.kind === 'audio' ? '<div class="ph">♪</div>' : `<img src="${esc(r.url)}" loading="lazy" />`}</div>`;

    async function pickFile(key, main) {
        const i = S.tool.inputs.find((x) => x.key === key);
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = ACCEPT[i.type] || '*/*';
        inp.onchange = async () => {
            const f = inp.files[0];
            if (!f) return;
            const status = main.querySelector('.tl-status');
            status.innerHTML = '<span class="spin"></span> Uploading…';
            try {
                const a = await engine.upload(f);
                S.values[key] = { id: a.id, url: a.url };
                renderTool(main);
            } catch (e) { status.textContent = `Upload failed: ${e.message}`; }
        };
        inp.click();
    }

    async function showLibrary(key, main) {
        const i = S.tool.inputs.find((x) => x.key === key);
        const box = main.querySelector(`[data-libfor="${key}"]`);
        if (box.innerHTML) { box.innerHTML = ''; return; }
        box.innerHTML = '<span class="muted"><span class="spin"></span></span>';
        S.media = S.media || (await engine.get('/media').catch(() => []));
        const items = S.media.filter((m) => m.kind === (i.type === 'image' ? 'images' : 'videos')).slice(0, 30);
        box.innerHTML = items.length ? items.map((m) => `<button type="button" data-use="${esc(m.id)}" title="${esc(m.prompt)}">${m.kind === 'videos' ? `<img src="${esc(m.thumb)}" />` : `<img src="${esc(m.url)}" loading="lazy" />`}</button>`).join('') : '<span class="muted">Nothing in the library yet.</span>';
        box.querySelectorAll('[data-use]').forEach((b) => (b.onclick = () => { const m = S.media.find((x) => x.id === b.dataset.use); S.values[key] = { id: m.id, url: m.url }; renderTool(main); }));
    }

    /* ---------------- sketch / mask canvas ---------------- */

    function annotate(key, main) {
        const i = S.tool.inputs.find((x) => x.key === key);
        const mask = i.annotate === 'mask';
        // A mask is painted over the tool's main image; a sketch is drawn on the input itself.
        const base = mask ? S.values.image : S.values[key];
        const src = base?.url || base;
        const ov = document.createElement('div');
        ov.className = 'eg-overlay eg';
        ov.innerHTML = `<div class="eg-modal tl-draw"><div class="hd"><h2>${mask ? 'Paint the area to change' : 'Draw arrows and notes'}</h2><button class="btn ghost" data-x>✕</button></div>
          <div class="bd"><div class="tl-canvas"><img /><canvas></canvas></div>
          <div class="row"><label class="f" style="width:auto"><span>Brush</span><input type="range" min="4" max="80" value="${mask ? 40 : 8}" data-size></label>
          ${mask ? '' : '<input type="text" data-note placeholder="Type a note, then click the image to place it" style="flex:1" />'}
          <button class="btn sm" data-undo>Undo</button><button class="btn sm" data-reset>Clear</button></div></div>
          <div class="ft"><button class="btn" data-x>Cancel</button><button class="btn primary" data-save>Use ${mask ? 'mask' : 'drawing'}</button></div></div>`;
        document.body.appendChild(ov);
        const img = ov.querySelector('img');
        const cv = ov.querySelector('canvas');
        const ctx = cv.getContext('2d');
        const strokes = [];
        img.crossOrigin = 'anonymous';
        img.onload = () => { cv.width = img.naturalWidth; cv.height = img.naturalHeight; redraw(); };
        img.src = src;
        function redraw() { ctx.clearRect(0, 0, cv.width, cv.height); paint(ctx, mask ? 'rgba(255,255,255,.8)' : '#ff2d2d'); }
        function paint(ctx, color) {
            for (const s of strokes) {
                if (s.text) { ctx.font = `bold ${Math.round(cv.width / 28)}px sans-serif`; ctx.fillStyle = color; ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText(s.text, s.x, s.y); ctx.fillText(s.text, s.x, s.y); continue; }
                ctx.strokeStyle = color; ctx.lineWidth = s.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                ctx.beginPath(); s.pts.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
                if (!mask && s.pts.length > 4) { // arrow head
                    const a = s.pts.at(-1); const b = s.pts.at(-5); const ang = Math.atan2(a.y - b.y, a.x - b.x); const L = s.size * 4;
                    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x - L * Math.cos(ang - 0.5), a.y - L * Math.sin(ang - 0.5)); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x - L * Math.cos(ang + 0.5), a.y - L * Math.sin(ang + 0.5)); ctx.stroke();
                }
            }
        }
        const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * cv.width, y: ((e.clientY - r.top) / r.height) * cv.height }; };
        let cur = null;
        cv.onpointerdown = (e) => {
            const note = ov.querySelector('[data-note]');
            if (note?.value.trim()) { strokes.push({ text: note.value.trim(), ...pos(e) }); note.value = ''; redraw(); return; }
            cur = { size: Number(ov.querySelector('[data-size]').value) * (cv.width / 1000), pts: [pos(e)] }; strokes.push(cur); cv.setPointerCapture(e.pointerId);
        };
        cv.onpointermove = (e) => { if (cur) { cur.pts.push(pos(e)); redraw(); } };
        cv.onpointerup = () => { cur = null; };
        ov.querySelector('[data-undo]').onclick = () => { strokes.pop(); redraw(); };
        ov.querySelector('[data-reset]').onclick = () => { strokes.length = 0; redraw(); };
        ov.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => ov.remove()));
        ov.querySelector('[data-save]').onclick = async () => {
            const out = document.createElement('canvas');
            out.width = cv.width; out.height = cv.height;
            const o = out.getContext('2d');
            // Mask: solid white strokes on black (white = change). Sketch: the drawing burned into the frame.
            if (mask) { o.fillStyle = '#000'; o.fillRect(0, 0, out.width, out.height); paint(o, '#fff'); }
            else { o.drawImage(img, 0, 0); o.drawImage(cv, 0, 0); }
            const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
            const a = await engine.upload(new File([blob], mask ? 'mask.png' : 'sketch.png', { type: 'image/png' }));
            S.values[key] = { id: a.id, url: a.url };
            ov.remove();
            renderTool(main);
        };
    }

    /* ---------------- run ---------------- */

    async function run(main) {
        const t = S.tool;
        const inputs = {};
        for (const i of t.inputs) {
            const v = S.values[i.key];
            if (v === undefined || v === '') continue;
            inputs[i.key] = typeof v === 'object' ? v.id || v.url : i.type === 'number' ? Number(v) : v;
        }
        const missing = t.inputs.find((i) => i.required && inputs[i.key] === undefined);
        const status = main.querySelector('.tl-status');
        if (missing) { status.textContent = `${missing.label} is required`; return; }
        const btn = main.querySelector('.tl-go');
        btn.disabled = true;
        const box = main.querySelector('.tl-result');
        box.innerHTML = '<div class="ph"><span class="spin"></span> <span data-msg>Starting…</span><div class="bar"><i style="width:0%"></i></div></div>';
        try {
            const job = await engine.runTool(t.id, inputs, {
                onUpdate: (j) => {
                    const m = box.querySelector('[data-msg]');
                    if (m) m.textContent = j.message || j.status;
                    const bar = box.querySelector('.bar i');
                    if (bar && j.progress != null) bar.style.width = `${Math.round(j.progress * 100)}%`;
                },
            });
            const entry = { tool: t.id, url: job.url, kind: job.kind, assets: job.assets, text: job.text, note: job.note, at: Date.now() };
            S.runs.unshift(entry);
            S.runs = S.runs.slice(0, 60);
            localStorage.setItem('tools_runs', JSON.stringify(S.runs));
            S.media = null;
            status.textContent = '';
            showResult(main, entry);
        } catch (e) {
            box.innerHTML = `<div class="ph tl-err">${esc(e.message)}</div>`;
        } finally { btn.disabled = false; }
    }

    function showResult(main, r) {
        if (!r) return;
        const box = main.querySelector('.tl-result');
        const one = (a) => a.kind === 'video' ? `<video src="${esc(a.url)}" controls autoplay loop playsinline></video>`
            : a.kind === 'audio' ? `<audio src="${esc(a.url)}" controls autoplay></audio>` : `<img src="${esc(a.url)}" />`;
        const list = r.assets?.length ? r.assets : [{ url: r.url, kind: r.kind }];
        box.innerHTML = `
          <div class="tl-res ${list.length > 1 ? 'multi' : ''}">${list.map((a) => `<figure>${one(a)}<figcaption><a href="${esc(a.url)}" download>Download</a></figcaption></figure>`).join('')}</div>
          ${r.note ? `<p class="muted tl-note">⚠ ${esc(r.note)}</p>` : ''}
          ${r.text ? `<p class="muted tl-text">${esc(r.text)}</p>` : ''}`;
    }

    load();
    return root;
}
