import '../styles/engine.css';
import { engine } from '../lib/engine.js';
import { ProvidersModal, toast } from './ProvidersModal.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = (sec) => `${Math.floor((sec || 0) / 60)}:${String(Math.round((sec || 0) % 60)).padStart(2, '0')}`;
const shotCount = (b) => Math.max(1, Math.round(((Number(b.targetMinutes) || 0) * 60) / (Number(b.clipSeconds) || 8)));
const PROVIDER_LABEL = { xai: 'xAI · Grok', google: 'Google · Gemini API', apimart: 'ApiMart', fal: 'fal.ai', replicate: 'Replicate', muapi: 'muapi.ai', kie: 'kie.ai', comfy: 'ComfyUI', local: 'Offline', handoff: 'Subscription hand-off (manual)' };
const VIDEO_PREF = ['xai/grok-imagine-video-1.5', 'google/gemini-omni-1.1-flash', 'fal/wan22-a14b', 'kie/veo3_fast', 'muapi/veo3.1-fast-image-to-video', 'replicate/wan22-fast', 'local/animatic'];
const IMAGE_PREF = ['google/gemini-nano-banana-2.1', 'xai/grok-imagine-image-2.0', 'fal/flux-dev', 'kie/nano-banana-2', 'replicate/flux-schnell', 'local/plate'];
const STATUS = {
    draft: ['', 'Draft'], planning: ['run', 'Planning'], planned: ['ok', 'Planned'], running: ['run', 'Rendering'], paused: ['warn', 'Paused'],
    review: ['ok', 'Ready to assemble'], done: ['ok', 'Done'], error: ['bad', 'Error'],
};
const SHOT = { pending: ['', 'Queued'], running: ['run', 'Rendering'], done: ['ok', 'Done'], error: ['bad', 'Failed'], skipped: ['', 'Skipped'], handoff: ['warn', 'Waiting for your clip'] };

export function LongFormStudio() {
    const root = document.createElement('div');
    root.className = 'eg lf flex-1 min-h-0';
    root.style.height = 'calc(100vh - 64px)';
    const fileInput = Object.assign(document.createElement('input'), { type: 'file', hidden: true });
    root.appendChild(fileInput);

    const S = { list: [], p: null, catalog: [], sound: { music: [], voice: [] }, editing: null, timer: null, patchTimer: null, pending: {} };
    const models = (kind) => S.catalog.filter((m) => m.kind === kind);
    const model = (id) => S.catalog.find((m) => m.id === id);
    const pickDefault = (prefs, kind) => prefs.find((id) => model(id)?.available) || models(kind).find((m) => m.available)?.id || prefs.at(-1);

    if (!engine.online) {
        root.innerHTML = `<div class="lf-main"><div class="empty">The long-form studio runs on the local engine.<br><br>Start it with <code>npm run engine</code> (or <code>npm run dev:local</code>) and reload.</div></div>`;
        return root;
    }

    /* ---------------- data ---------------- */

    async function refreshCatalog() {
        const [cat, sound] = await Promise.all([engine.get('/catalog'), engine.get('/sound').catch(() => S.sound)]);
        S.catalog = cat.models;
        S.sound = sound;
    }

    function soundSection(b) {
        const vp = S.sound.voice.find((v) => v.id === (b.voiceProvider === 'auto' ? (S.sound.voice.find((x) => x.available)?.id) : b.voiceProvider));
        const voices = vp?.voices || [];
        return `
          <div class="col" style="gap:8px;border-top:1px solid var(--eg-line);padding-top:12px">
            <h3 style="margin:0">Sound</h3>
            <label class="f"><span>Music</span><select data-b="music">
              <option value="off" ${b.music === 'off' ? 'selected' : ''}>No music</option>
              <option value="ai" ${b.music === 'ai' ? 'selected' : ''} ${S.sound.music.some((m) => m.available) ? '' : 'disabled'}>AI score per scene (Lyria${S.sound.music.some((m) => m.available) ? '' : ' — add a Gemini key'})</option>
              <option value="upload" ${b.music === 'upload' ? 'selected' : ''}>My own music file</option></select></label>
            ${b.music === 'ai' ? `<label class="f"><span>Music model</span><select data-b="musicModel">${S.sound.music.map((m) => `<option value="${m.id}" ${m.id === b.musicModel ? 'selected' : ''} ${m.available ? '' : 'disabled'}>${esc(m.label)}</option>`).join('')}</select></label>
              <label class="f"><span>Overall feel <em>optional — the director also writes one per scene</em></span><input type="text" data-b="musicPrompt" value="${esc(b.musicPrompt)}" placeholder="Sparse piano and strings, slow build, hopeful"/></label>` : ''}
            ${b.music === 'upload' ? `<div class="row"><button class="btn sm" data-a="music-file">${b.musicUrl ? 'Replace music file' : 'Choose music file'}</button>${b.musicUrl ? `<audio src="${esc(b.musicUrl)}" controls style="height:30px;flex:1;min-width:0"></audio>` : ''}</div>` : ''}
            ${b.music !== 'off' ? `<label class="f"><span>Music volume <em>${Math.round((b.musicVolume ?? 0.35) * 100)}%</em></span><input type="range" min="0" max="1" step="0.05" data-b="musicVolume" data-num value="${b.musicVolume ?? 0.35}"/></label>` : ''}
            <label class="toggle"><input type="checkbox" data-b="narration" ${b.narration ? 'checked' : ''}/> Add a narrator (the director writes a line per shot)</label>
            ${b.narration ? `<div class="grid2">
                <label class="f"><span>Voice from</span><select data-b="voiceProvider"><option value="auto" ${b.voiceProvider === 'auto' ? 'selected' : ''}>Best available</option>${S.sound.voice.map((v) => `<option value="${v.id}" ${v.id === b.voiceProvider ? 'selected' : ''} ${v.available ? '' : 'disabled'}>${esc(v.label)}</option>`).join('')}</select></label>
                <label class="f"><span>Voice</span><select data-b="voice"><option value="">Default</option>${voices.map((v) => { const id = typeof v === 'string' ? v : v.id; return `<option value="${esc(id)}" ${id === b.voice ? 'selected' : ''}>${esc(typeof v === 'string' ? v : v.name)}</option>`; }).join('')}</select></label></div>
              <label class="f"><span>Narrator style</span><input type="text" data-b="narratorStyle" value="${esc(b.narratorStyle)}"/></label>
              <p class="dim" style="font-size:11.5px">Narration and music are added when the master is assembled. Change them any time and press “Assemble master” again — clips are not re-rendered.</p>` : ''}
          </div>`;
    }

    async function load(id) {
        S.list = await engine.get('/productions');
        const want = id || localStorage.getItem('lf_production') || S.list[0]?.id;
        S.p = want && S.list.some((x) => x.id === want) ? await engine.get(`/productions/${want}`) : null;
        if (S.p) localStorage.setItem('lf_production', S.p.id);
        renderAll();
        schedule();
    }

    async function create() {
        await refreshCatalog();
        const p = await engine.post('/productions', {
            title: 'Untitled film',
            videoModel: pickDefault(VIDEO_PREF, 'video'),
            imageModel: pickDefault(IMAGE_PREF, 'image'),
        });
        await load(p.id);
    }

    function patchBrief(fields) {
        Object.assign(S.p.brief, fields);
        Object.assign(S.pending, fields);
        clearTimeout(S.patchTimer);
        S.patchTimer = setTimeout(flush, 400);
        if (['title', 'targetMinutes', 'clipSeconds', 'videoModel'].some((k) => k in fields)) renderMain();
    }
    async function flush() {
        clearTimeout(S.patchTimer);
        const body = S.pending;
        S.pending = {};
        if (!Object.keys(body).length || !S.p) return;
        try { S.p = await engine.patch(`/productions/${S.p.id}`, body); } catch (e) { toast(e.message, true); }
    }

    async function act(path, body, method = 'post') {
        await flush();
        try {
            S.p = await engine[method](`/productions/${S.p.id}${path}`, body);
            renderMain();
            schedule();
        } catch (e) { toast(e.message, true); }
    }

    function schedule() {
        clearTimeout(S.timer);
        if (!S.p || !document.body.contains(root)) return;
        const live = ['planning', 'running'].includes(S.p.status) || S.p.assembling || S.p.shots.some((s) => s.status === 'handoff');
        S.timer = setTimeout(async () => {
            if (!document.body.contains(root)) return;
            try {
                const before = S.p.status;
                S.p = await engine.get(`/productions/${S.p.id}`);
                for (const [k, v] of Object.entries(S.pending)) S.p.brief[k] = v;
                if (before === 'planning' && S.p.status !== 'planning') renderSide();
                if (!root.querySelector('.lf-main')?.contains(document.activeElement) || document.activeElement === document.body) renderMain();
                else renderMain(true);
            } catch {}
            schedule();
        }, live ? 2000 : 8000);
    }

    /* ---------------- render ---------------- */

    function modelOptions(kind, selected, { includeHandoff } = {}) {
        const groups = {};
        for (const m of models(kind)) {
            if (m.provider === 'handoff' && !includeHandoff) continue;
            (groups[m.provider] ||= []).push(m);
        }
        return Object.entries(groups).map(([prov, ms]) => `<optgroup label="${esc(PROVIDER_LABEL[prov] || prov)}${ms[0].available ? '' : ' — connect in Providers'}">${ms.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''} ${m.available ? '' : 'disabled'}>${esc(m.label)}</option>`).join('')}</optgroup>`).join('');
    }

    function renderAll() { renderSide(); renderMain(); }

    function renderSide() {
        let side = root.querySelector('.lf-side');
        if (!side) { side = document.createElement('aside'); side.className = 'lf-side'; root.insertBefore(side, root.querySelector('.lf-main')); }
        const prodbar = `<div class="prodbar"><select data-a="switch">${S.list.length ? S.list.map((x) => `<option value="${x.id}" ${x.id === S.p?.id ? 'selected' : ''}>${esc(x.title)} · ${x.done}/${x.shots}</option>`).join('') : '<option>No productions yet</option>'}</select><button class="btn sm primary" data-a="new">＋ New</button></div>`;
        if (!S.p) {
            side.innerHTML = `${prodbar}<div class="card col"><h3>Long-form</h3><p class="muted">Turn a script into a 5–10+ minute film: a director LLM plans scenes and shots, every shot renders on the provider you pick with continuity between shots, and the engine cuts everything into one master with audio.</p><button class="btn primary" data-a="new">Start a production</button></div>`;
            return;
        }
        const b = S.p.brief;
        const vm = model(b.videoModel);
        const durs = vm?.durations?.length ? vm.durations : [5, 8, 10];
        const shots = shotCount(b);
        side.innerHTML = `${prodbar}
          <label class="f"><span>Title</span><input type="text" data-b="title" value="${esc(b.title)}"/></label>
          <label class="f"><span>Script / story <em>paste a script, treatment or logline</em></span><textarea data-b="script" rows="9" placeholder="INT. ORBITAL GREENHOUSE — NIGHT. Mara, a botanist in a faded orange flight suit, discovers one seedling glowing…">${esc(b.script)}</textarea></label>
          <label class="f"><span>Look & style <em>applied to every shot</em></span><input type="text" data-b="style" value="${esc(b.style)}" placeholder="Anamorphic 35mm film, teal-orange grade, soft haze, shallow depth of field"/></label>
          <div class="col chars">
            <h3 style="margin:4px 0 0">Characters <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:500">— fixed look + reference image keeps them consistent</span></h3>
            ${(b.characters || []).map((c, i) => `<div class="ch">
                <div class="ref" data-a="char-ref" data-i="${i}" title="Reference image">${c.refUrl ? `<img src="${esc(c.refUrl)}" alt=""/>` : '＋ ref'}</div>
                <div class="col" style="gap:5px"><input type="text" data-c="name" data-i="${i}" value="${esc(c.name)}" placeholder="Name"/><textarea rows="2" data-c="description" data-i="${i}" placeholder="Face, hair, age, wardrobe…">${esc(c.description)}</textarea></div>
                <button class="btn ghost sm" data-a="char-del" data-i="${i}" title="Remove">✕</button></div>`).join('')}
            <button class="btn sm" data-a="char-add">＋ Add character</button>
          </div>
          <div class="grid2">
            <label class="f"><span>Length (min) <em data-shotcount>${shots} shots</em></span><input type="number" min="0.5" max="30" step="0.5" data-b="targetMinutes" data-num value="${b.targetMinutes}"/></label>
            <label class="f"><span>Clip length</span><select data-b="clipSeconds" data-num>${durs.map((d) => `<option value="${d}" ${Number(b.clipSeconds) === d ? 'selected' : ''}>${d}s</option>`).join('')}</select></label>
            <label class="f"><span>Aspect</span><select data-b="aspect">${(vm?.aspects || ['16:9', '9:16']).map((a) => `<option ${a === b.aspect ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
            <label class="f"><span>Resolution</span><select data-b="resolution">${(vm?.resolutions?.length ? vm.resolutions : ['720p']).map((r) => `<option ${r === b.resolution ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
          </div>
          <label class="f"><span>Video model</span><select data-b="videoModel">${modelOptions('video', b.videoModel, { includeHandoff: true })}</select></label>
          ${vm?.blurb ? `<p class="dim" style="font-size:11.5px;margin-top:-4px">${esc(vm.blurb)}</p>` : ''}
          <label class="f"><span>Keyframe model <em>for cuts &amp; characters</em></span><select data-b="imageModel">${modelOptions('image', b.imageModel)}</select></label>
          <label class="f"><span>Continuity between shots</span><select data-b="continuity">
            <option value="extend" ${b.continuity === 'extend' ? 'selected' : ''}>Native extend when possible, else last frame</option>
            <option value="lastframe" ${b.continuity === 'lastframe' ? 'selected' : ''}>Start each shot from the previous last frame</option>
            <option value="cut" ${b.continuity === 'cut' ? 'selected' : ''}>Independent shots (fastest, fully parallel)</option></select></label>
          <div class="col" style="gap:6px">
            <label class="toggle"><input type="checkbox" data-b="keyframes" ${b.keyframes ? 'checked' : ''}/> Generate a keyframe for every cut (better consistency)</label>
            <label class="toggle"><input type="checkbox" data-b="sceneFades" ${b.sceneFades ? 'checked' : ''}/> Fade between scenes</label>
            <label class="toggle"><input type="checkbox" data-b="autoAssemble" ${b.autoAssemble ? 'checked' : ''}/> Assemble the master automatically</label>
          </div>
          ${soundSection(b)}
          <button class="btn ghost sm" data-a="providers">Providers & accounts…</button>`;
    }

    function shotRow(s) {
        const [cls, label] = SHOT[s.status] || ['', s.status];
        const m = model(s.model || S.p.brief.videoModel);
        const thumb = s.videoUrl
            ? `<div class="thumb" data-a="play" data-id="${s.id}">${s.posterUrl ? `<img src="${esc(s.posterUrl)}" alt=""/>` : `<video src="${esc(s.videoUrl)}" muted preload="metadata"></video>`}<span class="dur">▶ ${(s.clipDuration || 0).toFixed(1)}s</span></div>`
            : `<div class="thumb">${s.keyframeUrl || s.startFrameUrl ? `<img src="${esc(s.startFrameUrl || s.keyframeUrl)}" alt="" style="opacity:.55"/>` : ''}<div class="ph">${s.status === 'running' ? '<span class="spin"></span>' : ''}</div></div>`;
        const editing = S.editing === s.id;
        return `<div class="shot" data-shot="${s.id}">
          <div class="n">${String(s.index + 1).padStart(2, '0')}</div>
          ${thumb}
          <div class="grow">
            <div class="t">${esc(s.title || `Shot ${s.index + 1}`)}
              <button class="cont ${s.continuity === 'continue' ? 'c' : ''}" data-a="cont" data-id="${s.id}" title="Toggle: continue from previous shot / hard cut">${s.continuity === 'continue' ? '↳ continue' : '✂ cut'}</button>
              <span class="chip ${cls}"><i></i>${label}</span>
              ${s.model ? `<span class="dim" style="font-size:11px">${esc(m?.label || s.model)}</span>` : ''}
            </div>
            ${editing ? `<textarea data-edit="${s.id}" rows="5">${esc(s.prompt)}</textarea>${S.p.brief.narration ? `<input type="text" data-edit-narr="${s.id}" value="${esc(s.narration || '')}" placeholder="Narration for this shot (optional)" style="margin-top:6px"/>` : ''}<div class="row" style="margin-top:6px"><button class="btn sm primary" data-a="save-prompt" data-id="${s.id}">Save</button><button class="btn sm ghost" data-a="cancel-edit">Cancel</button><select data-shot-model="${s.id}" style="width:auto;margin-left:auto">${`<option value="">Production model</option>${modelOptions('video', s.model, { includeHandoff: true })}`}</select></div>` : `<div class="p" data-a="edit" data-id="${s.id}" title="Click to edit">${esc(s.prompt)}</div>`}
            ${S.p.brief.narration && s.narration && !editing ? `<div class="msg" style="color:#cfe3ff">🎙 ${esc(s.narration)}</div>` : ''}
            ${s.message && s.status !== 'done' ? `<div class="msg">${esc(s.message)}</div>` : ''}
            ${s.error && s.status === 'error' ? `<div class="msg err">${esc(s.error)}</div>` : ''}
          </div>
          <div class="acts">
            ${['done', 'error', 'skipped'].includes(s.status) ? `<button class="btn sm" data-a="retry" data-id="${s.id}">↻ ${s.status === 'done' ? 'Re-render' : 'Retry'}</button>` : ''}
            ${s.status === 'pending' || s.status === 'handoff' ? `<button class="btn sm ghost" data-a="skip" data-id="${s.id}">Skip</button>` : ''}
            <button class="btn sm ghost" data-a="import" data-id="${s.id}" title="Use your own clip for this shot">⇪ Import clip</button>
            ${s.videoUrl ? `<a class="btn sm ghost" href="${esc(s.videoUrl)}" download>↓ Clip</a>` : ''}
          </div></div>`;
    }

    function renderMain(statusOnly = false) {
        let main = root.querySelector('.lf-main');
        if (!main) { main = document.createElement('main'); main.className = 'lf-main'; root.appendChild(main); }
        if (!S.p) { main.innerHTML = '<div class="empty">Create a production to get started.</div>'; return; }
        const p = S.p;
        const b = p.brief;
        const [cls, label] = STATUS[p.status] || ['', p.status];
        const done = p.shots.filter((s) => s.status === 'done');
        const rendered = done.reduce((t, s) => t + (s.clipDuration || 0), 0);
        const running = p.shots.filter((s) => s.status === 'running').length;
        const failed = p.shots.filter((s) => s.status === 'error').length;
        const waiting = p.shots.filter((s) => s.status === 'handoff');
        const head = `
          <div class="row" style="align-items:flex-start">
            <div class="col grow" style="gap:4px"><h2>${esc(p.title)}</h2><p class="muted" style="font-size:12px">${esc(p.plan?.logline || `${b.targetMinutes} min · ${shotCount(b)} shots × ${b.clipSeconds}s · ${model(b.videoModel)?.label || b.videoModel}`)}</p></div>
            <span class="chip ${p.assembling ? 'run' : cls}"><i></i>${p.assembling ? 'Assembling' : label}</span>
          </div>
          <div class="row" style="flex-wrap:wrap">
            ${p.status === 'running' ? '<button class="btn" data-a="pause">❚❚ Pause</button>' : `<button class="btn primary" data-a="start" ${p.shots.length && p.status !== 'planning' ? '' : 'disabled'}>${p.status === 'paused' ? '▶ Resume' : p.status === 'review' || p.status === 'done' ? '▶ Render remaining' : '▶ Start rendering'}</button>`}
            <button class="btn" data-a="plan" ${['running', 'planning'].includes(p.status) ? 'disabled' : ''}>${p.status === 'planning' ? '<span class="spin"></span> Planning…' : p.shots.length ? '✦ Re-plan with director' : '✦ Plan with director'}</button>
            <button class="btn" data-a="assemble" ${done.length && !p.assembling ? '' : 'disabled'}>${p.assembling ? '<span class="spin"></span> Assembling…' : '⧉ Assemble master'}</button>
            <span class="grow"></span>
            <button class="btn ghost sm" data-a="delete">Delete</button>
          </div>
          ${p.message ? `<p class="muted" style="font-size:12px">${esc(p.message)}</p>` : ''}
          <div class="stats">
            <div class="stat"><b>${done.length}/${p.shots.length || shotCount(b)}</b><span>shots rendered</span></div>
            <div class="stat"><b>${mmss(rendered)}</b><span>of ${mmss(b.targetMinutes * 60)} target</span></div>
            <div class="stat"><b>${running}</b><span>rendering now</span></div>
            <div class="stat"><b style="color:${failed ? 'var(--eg-bad)' : 'inherit'}">${failed}</b><span>failed</span></div>
          </div>
          ${p.shots.length ? `<div class="bar"><i style="width:${Math.round((done.length / p.shots.length) * 100)}%"></i></div>` : ''}`;

        const handoff = waiting.length ? (() => {
            const s = waiting[0];
            const m = model(s.model || b.videoModel);
            return `<div class="handoff">
              <div class="row"><b>Your turn: shot ${s.index + 1}${waiting.length > 1 ? ` (+${waiting.length - 1} more waiting)` : ''}</b><span class="grow"></span>
                <label class="toggle"><input type="checkbox" data-a="autoimport" ${p.handoff?.autoImport ? 'checked' : ''}/> Auto-import new downloads</label></div>
              <p class="muted" style="font-size:12px">Generate this shot in ${m?.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.label.replace('Hand-off: ', ''))}</a>` : 'your app'} with your subscription${s.startFrameUrl ? ' using the start frame below' : ''}, then download it${p.handoff?.autoImport ? ' — it is picked up from your downloads folder automatically' : ' and import it here'}.</p>
              <div class="row" style="align-items:flex-start">
                ${s.startFrameUrl ? `<a href="${esc(s.startFrameUrl)}" download="shot-${s.index + 1}-start.jpg" title="Download start frame"><img src="${esc(s.startFrameUrl)}" style="width:160px;border-radius:8px;border:1px solid var(--eg-line)" alt=""/></a>` : ''}
                <div class="col grow"><textarea readonly rows="4" class="mono">${esc(s.prompt)}</textarea>
                  <div class="row"><button class="btn sm" data-a="copy" data-id="${s.id}">Copy prompt</button>${m?.url ? `<a class="btn sm" href="${esc(m.url)}" target="_blank" rel="noopener">Open ${esc(m.label.replace('Hand-off: ', ''))} ↗</a>` : ''}<button class="btn sm primary" data-a="import" data-id="${s.id}">⇪ Import clip</button></div></div>
              </div></div>`;
        })() : '';

        const master = p.master?.url ? `<div class="card master col"><div class="row"><h3 style="margin:0">Master</h3><span class="dim" style="font-size:12px">${mmss(p.master.duration)} · ${p.master.shots} shots · ${new Date(p.master.createdAt).toLocaleString()}</span><span class="grow"></span><a class="btn sm primary" href="${esc(p.master.url)}" download="${esc(p.title)}.mp4">↓ Download master</a></div><video src="${esc(p.master.url)}" controls playsinline preload="metadata"></video></div>` : '';

        if (statusOnly) {
            const top = main.querySelector('[data-region="head"]');
            if (top) top.innerHTML = head;
            for (const s of p.shots) {
                const row = main.querySelector(`[data-shot="${s.id}"]`);
                if (row && !row.contains(document.activeElement)) row.outerHTML = shotRow(s);
            }
            return;
        }

        const scenes = (p.scenes || []).map((sc, i) => {
            const shots = p.shots.filter((s) => s.sceneId === sc.id);
            if (!shots.length) return '';
            const musicLine = p.brief.music === 'ai' && sc.music ? `<div style="padding:6px 14px;font-size:11.5px;color:var(--text-secondary);border-bottom:1px solid var(--eg-line)">♪ ${esc(sc.music)}${sc.musicUrl ? ` <audio src="${esc(sc.musicUrl)}" controls style="height:24px;vertical-align:middle;margin-left:8px"></audio>` : ''}</div>` : '';
            return `<div class="scene"><div class="scene-hd"><b>${i + 1}. ${esc(sc.title)}</b><span>${esc(sc.summary)}</span><span class="dim mono">${shots.length} shots</span></div>${musicLine}${shots.map(shotRow).join('')}</div>`;
        }).join('');
        const orphans = p.shots.filter((s) => !(p.scenes || []).some((sc) => sc.id === s.sceneId));
        const scroll = main.scrollTop;
        main.innerHTML = `
          <div class="col" data-region="head" style="gap:12px">${head}</div>
          ${handoff}
          ${master}
          ${p.shots.length ? `${scenes}${orphans.length ? `<div class="scene"><div class="scene-hd"><b>Extra shots</b></div>${orphans.map(shotRow).join('')}</div>` : ''}` : `<div class="empty">${p.status === 'planning' ? '<span class="spin"></span> The director is writing your shot list…' : 'Write or paste your script on the left, then <b>Plan with director</b>. You can edit every shot before rendering.'}</div>`}
          ${p.log?.length ? `<details><summary class="muted" style="cursor:pointer;font-size:12px">Production log</summary><div class="log">${p.log.slice().reverse().map((l) => `<div>${new Date(l.at).toLocaleTimeString()} — ${esc(l.msg)}</div>`).join('')}</div></details>` : ''}`;
        main.scrollTop = scroll;
    }

    /* ---------------- events ---------------- */

    let fileTarget = null;
    const pickFile = (accept, target) => { fileTarget = target; fileInput.accept = accept; fileInput.value = ''; fileInput.click(); };

    fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        if (!f || !fileTarget) return;
        const t = fileTarget;
        fileTarget = null;
        try {
            toast(`Uploading ${f.name}…`);
            const asset = await engine.upload(f);
            if (t.type === 'char') {
                const chars = [...(S.p.brief.characters || [])];
                chars[t.i] = { ...chars[t.i], refAssetId: asset.id, refUrl: asset.url };
                patchBrief({ characters: chars });
                renderSide();
            } else if (t.type === 'music') {
                patchBrief({ musicAssetId: asset.id, musicUrl: asset.url });
                renderSide();
                toast('Music added — it plays under the whole film');
            } else if (t.type === 'clip') {
                await act(`/shots/${t.id}/import`, { assetId: asset.id });
                toast('Clip imported');
            }
        } catch (e) { toast(e.message, true); }
    });

    root.addEventListener('click', async (e) => {
        const el = e.target.closest('[data-a]');
        if (!el || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'checkbox')) return;
        const a = el.dataset.a;
        const id = el.dataset.id;
        try {
            switch (a) {
                case 'new': await create(); return;
                case 'providers': ProvidersModal(); return;
                case 'plan':
                    if (S.p.shots.some((s) => s.status === 'done') && !confirm('Re-planning replaces the shot list (rendered clips stay in your library). Continue?')) return;
                    return act('/plan');
                case 'start': return act('/start');
                case 'pause': return act('/pause');
                case 'assemble': return act('/assemble');
                case 'delete':
                    if (!confirm(`Delete “${S.p.title}”? Rendered media stays in engine-data/media.`)) return;
                    await engine.del(`/productions/${S.p.id}`);
                    localStorage.removeItem('lf_production');
                    return load();
                case 'cont': {
                    const s = S.p.shots.find((x) => x.id === id);
                    return act(`/shots/${id}`, { continuity: s.continuity === 'continue' ? 'cut' : 'continue' }, 'patch');
                }
                case 'edit': S.editing = id; renderMain(); root.querySelector(`[data-edit="${id}"]`)?.focus(); return;
                case 'cancel-edit': S.editing = null; return renderMain();
                case 'save-prompt': {
                    const prompt = root.querySelector(`[data-edit="${id}"]`).value;
                    const mSel = root.querySelector(`[data-shot-model="${id}"]`)?.value || null;
                    const narr = root.querySelector(`[data-edit-narr="${id}"]`);
                    S.editing = null;
                    return act(`/shots/${id}`, { prompt, model: mSel, ...(narr ? { narration: narr.value } : {}) }, 'patch');
                }
                case 'retry': return act(`/shots/${id}`, { reset: true }, 'patch');
                case 'skip': return act(`/shots/${id}`, { skip: true }, 'patch');
                case 'import': return pickFile('video/*', { type: 'clip', id });
                case 'copy': {
                    const s = S.p.shots.find((x) => x.id === id);
                    await navigator.clipboard.writeText(s.prompt);
                    return toast('Prompt copied');
                }
                case 'autoimport': return act('/autoimport', { on: el.checked });
                case 'play': {
                    const s = S.p.shots.find((x) => x.id === id);
                    el.innerHTML = `<video src="${esc(s.videoUrl)}" autoplay controls playsinline></video>`;
                    el.removeAttribute('data-a');
                    return;
                }
                case 'char-add': {
                    const chars = [...(S.p.brief.characters || []), { name: '', description: '' }];
                    patchBrief({ characters: chars });
                    S.p.brief.characters = chars;
                    return renderSide();
                }
                case 'char-del': {
                    const chars = (S.p.brief.characters || []).filter((_, i) => i !== Number(el.dataset.i));
                    patchBrief({ characters: chars });
                    S.p.brief.characters = chars;
                    return renderSide();
                }
                case 'char-ref': return pickFile('image/*', { type: 'char', i: Number(el.dataset.i) });
                case 'music-file': return pickFile('audio/*', { type: 'music' });
            }
        } catch (err) { toast(err.message, true); }
    });

    root.addEventListener('input', (e) => {
        const el = e.target;
        if (el.dataset.b && el.type !== 'checkbox' && el.tagName !== 'SELECT') {
            patchBrief({ [el.dataset.b]: el.dataset.num !== undefined ? Number(el.value) : el.value });
            if (el.dataset.b === 'musicVolume') { const em = el.closest('label')?.querySelector('em'); if (em) em.textContent = `${Math.round(Number(el.value) * 100)}%`; }
            const sc = root.querySelector('[data-shotcount]');
            if (sc) sc.textContent = `${shotCount(S.p.brief)} shots`;
        }
        if (el.dataset.c) {
            const chars = (S.p.brief.characters || []).map((c, i) => (i === Number(el.dataset.i) ? { ...c, [el.dataset.c]: el.value } : c));
            S.p.brief.characters = chars;
            patchBrief({ characters: chars });
        }
    });

    root.addEventListener('change', async (e) => {
        const el = e.target;
        if (el.dataset.a === 'switch') { await flush(); S.editing = null; return load(el.value); }
        if (el.dataset.b && (el.type === 'checkbox' || el.tagName === 'SELECT')) {
            const v = el.type === 'checkbox' ? el.checked : el.dataset.num !== undefined ? Number(el.value) : el.value;
            patchBrief({ [el.dataset.b]: v });
            if (el.dataset.b === 'videoModel') {
                const vm = model(v);
                if (vm?.durations?.length && !vm.durations.includes(Number(S.p.brief.clipSeconds))) patchBrief({ clipSeconds: vm.durations.includes(8) ? 8 : vm.durations.at(-1) });
                if (vm?.aspects && !vm.aspects.includes(S.p.brief.aspect)) patchBrief({ aspect: vm.aspects[0] });
                if (vm?.resolutions?.length && !vm.resolutions.includes(S.p.brief.resolution)) patchBrief({ resolution: vm.resolutionDefault || vm.resolutions[0] });
            }
            // Voice ids belong to one provider (an ElevenLabs id means nothing to Gemini).
            if (el.dataset.b === 'voiceProvider') patchBrief({ voice: '' });
            if (['videoModel', 'clipSeconds', 'targetMinutes', 'music', 'narration', 'voiceProvider'].includes(el.dataset.b)) renderSide();
        }
    });

    window.addEventListener('engine:catalog-changed', async () => { if (document.body.contains(root)) { await refreshCatalog(); renderSide(); renderMain(); } });

    root.insertAdjacentHTML('beforeend', '<main class="lf-main"><div class="muted"><span class="spin"></span> Loading…</div></main>');
    refreshCatalog().then(() => load()).catch((e) => toast(e.message, true));
    return root;
}
