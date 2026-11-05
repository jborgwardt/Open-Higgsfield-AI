import '../styles/engine.css';
import '../styles/characters.css';
import { engine } from '../lib/engine.js';
import { toast } from './ProvidersModal.js';
import { loadCharacters } from './CharacterPicker.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = (n) => esc(String(n || '?').trim().charAt(0).toUpperCase());
const ANGLES = [['front', 'Front'], ['threeQuarterLeft', '¾ left'], ['threeQuarterRight', '¾ right'], ['profileLeft', 'Profile left'], ['profileRight', 'Profile right'], ['back', 'Back'], ['unknown', 'Angle?']];
const EXPR = { neutral: 'neutral', 'smile-teeth': 'smile (teeth)', 'smile-closed': 'closed smile', laugh: 'laughing', other: 'expression' };
const KIND = { photo: 'Photo', 'video-frame': 'Video frame', sheet: 'Sheet' };
const scoreCls = (s) => (s == null ? 'na' : s >= 70 ? 'hi' : s >= 45 ? 'mid' : 'lo');

/**
 * Characters: build a reusable person from photos and/or a head-turn video, see what each reference is worth,
 * what is still missing, generate + approve a model sheet, set look notes and a voice.
 */
export function CharactersPage() {
    const root = document.createElement('div');
    root.className = 'eg chp flex-1 min-h-0';
    root.style.height = 'calc(100vh - 64px)';
    if (!engine.online) {
        root.innerHTML = '<div class="chp-main"><div class="chp-empty">Characters live on the local engine.<br>Start it with <code>npm run engine</code> (or <code>npm run dev:local</code>) and reload.</div></div>';
        return root;
    }
    const fileInput = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: 'image/*,video/*,.heic,.heif,.mov', hidden: true });
    root.appendChild(fileInput);

    const S = { list: [], c: null, cov: null, voices: null, uploading: null, timer: null, patchTimer: null, pending: {}, sheetJob: null };

    /* ---------------- data ---------------- */

    async function loadList(selectId) {
        S.list = await loadCharacters(true);
        const want = selectId || S.c?.id || localStorage.getItem('char_current') || S.list[0]?.id;
        await open(S.list.some((c) => c.id === want) ? want : S.list[0]?.id, { full: true });
    }

    async function open(id, { full } = {}) {
        if (!id) { S.c = null; S.cov = null; renderAll(); return; }
        const [c, cov] = await Promise.all([engine.get(`/characters/${id}`), engine.get(`/characters/${id}/coverage`)]);
        const switched = S.c?.id !== c.id;
        S.c = c;
        S.cov = cov;
        localStorage.setItem('char_current', id);
        const i = S.list.findIndex((x) => x.id === id);
        if (i >= 0) S.list[i] = c;
        if (full || switched) renderAll(); else renderLive();
        if (c.sheetJob && !S.sheetJob) watchSheet(c.sheetJob.jobId);
        schedule();
    }

    async function voices() {
        if (S.voices) return S.voices;
        const snd = await engine.get('/sound').catch(() => null);
        const el = snd?.voice?.find((v) => v.id === 'eleven');
        S.voices = { available: !!el?.available, list: el?.voices || [] };
        return S.voices;
    }

    const busy = () => S.c && (S.c.processing?.length || S.c.refs.some((r) => r.status === 'analyzing') || S.c.sheetJob);
    function schedule() {
        clearTimeout(S.timer);
        if (!S.c || !busy()) return;
        S.timer = setTimeout(() => { if (document.body.contains(root) && S.c) open(S.c.id).catch(() => {}); }, 2000);
    }

    function patch(fields) {
        Object.assign(S.c, fields);
        Object.assign(S.pending, fields);
        clearTimeout(S.patchTimer);
        S.patchTimer = setTimeout(flush, 500);
    }
    async function flush() {
        clearTimeout(S.patchTimer);
        const body = S.pending;
        S.pending = {};
        if (!Object.keys(body).length || !S.c) return;
        try {
            const c = await engine.patch(`/characters/${S.c.id}`, body);
            const i = S.list.findIndex((x) => x.id === c.id);
            if (i >= 0) S.list[i] = c;
            if ('name' in body) renderSide();
        } catch (e) { toast(e.message, true); }
    }

    async function uploadFiles(files) {
        files = [...files].filter((f) => /^(image|video)\//.test(f.type) || /\.(heic|heif|mov|mp4|jpe?g|png|webp)$/i.test(f.name));
        if (!files.length || !S.c) return;
        const ids = [];
        try {
            for (const [i, f] of files.entries()) {
                S.uploading = `Uploading ${i + 1}/${files.length} · ${f.name}`;
                renderRefs();
                ids.push((await engine.upload(f)).id);
            }
            S.uploading = files.some((f) => /^video\//.test(f.type) || /\.(mov|mp4)$/i.test(f.name)) ? 'Picking the best frames from your video…' : 'Checking photos…';
            renderRefs();
            const r = await engine.post(`/characters/${S.c.id}/refs`, { assetIds: ids });
            if (r.skipped?.length) toast(`${r.skipped.length} skipped: ${r.skipped.map((s) => s.reason).join('; ')}`, true);
        } catch (e) { toast(e.message, true); }
        S.uploading = null;
        await open(S.c.id);
    }

    function watchSheet(jobId) {
        S.sheetJob = { id: jobId, message: 'Starting' };
        renderSheet();
        const tick = async () => {
            if (!document.body.contains(root) || S.sheetJob?.id !== jobId) return;
            try {
                const j = await engine.get(`/jobs/${jobId}`);
                S.sheetJob.message = j.message;
                if (j.status === 'running') { renderSheet(); setTimeout(tick, 2500); return; }
                S.sheetJob = null;
                if (j.status === 'error') toast(j.error || 'Sheet failed', true);
                await open(S.c.id);
            } catch { S.sheetJob = null; renderSheet(); }
        };
        setTimeout(tick, 1500);
    }

    /* ---------------- render ---------------- */

    function renderAll() {
        root.querySelectorAll('.chp-side, .chp-main').forEach((n) => n.remove());
        root.insertAdjacentHTML('beforeend', '<aside class="chp-side"></aside><main class="chp-main"></main>');
        renderSide();
        renderMain();
    }

    function renderSide() {
        const side = root.querySelector('.chp-side');
        if (!side) return;
        side.innerHTML = `
          <div class="row"><h2 class="grow">Characters</h2><button class="btn sm primary" data-a="new">＋ New</button></div>
          <p class="dim" style="font-size:11.5px;line-height:1.5">Keep a real person consistent across every model: photos → graded references → an approved model sheet.</p>
          ${S.list.map((c) => `<div class="chp-item ${c.id === S.c?.id ? 'on' : ''}" data-a="open" data-id="${esc(c.id)}">
              <div class="chp-av" style="${c.coverUrl ? `background-image:url('${esc(c.coverUrl)}')` : ''}">${c.coverUrl ? '' : initial(c.name)}</div>
              <div style="min-width:0"><b>${esc(c.name)}</b><small><span class="chp-meter"><i style="width:${c.coverage?.percent ?? 0}%"></i></span>${c.coverage?.percent ?? 0}% · ${c.refs.length} refs${c.approvedSheet ? ' · sheet ✓' : ''}</small></div></div>`).join('')}`;
    }

    function renderMain() {
        const main = root.querySelector('.chp-main');
        if (!main) return;
        if (!S.c) {
            main.innerHTML = `<div class="chp-empty"><div class="chp-av lg">＋</div><h2>Create your first character</h2><p style="max-width:440px;line-height:1.55">Add a few photos (or a 10–15 s head-turn video) of a person. Every reference is graded for sharpness, angle, filters and selfie distortion, and the studio tells you exactly which shots are still missing.</p><button class="btn primary" data-a="new">＋ New character</button></div>`;
            return;
        }
        const c = S.c;
        main.innerHTML = `
          <div class="chp-head" data-r="head"></div>
          <div class="chp-grid2">
            <div class="col" style="gap:14px">
              <div class="card" data-r="refs"></div>
              <div class="card" data-r="sheet"></div>
            </div>
            <div class="col" style="gap:14px">
              <div class="card col" data-r="identity">
                <h3 style="margin:0">Identity</h3>
                <label class="f"><span>Description <em>used in every prompt</em></span><textarea rows="3" data-f="description" placeholder="Late 30s, short dark-blond hair swept back, full beard, blue-grey eyes">${esc(c.description)}</textarea></label>
                <label class="f"><span>Look notes <em>how renders should differ from the photos</em></span><textarea rows="2" data-f="lookNotes" placeholder="A little slimmer than the photos, still a bit of softness at the jaw">${esc(c.lookNotes)}</textarea></label>
                <label class="f"><span>Voice <em>ElevenLabs — narration &amp; voice changer</em></span><select data-f="voice"><option value="">Loading voices…</option></select></label>
                <label class="toggle" title="Real people get identity lock (reference-to-video models only). Untick for fictional / AI-generated characters."><input type="checkbox" data-f="realPerson" ${c.realPerson !== false ? 'checked' : ''}/> Real person — always render with reference-to-video models</label>
              </div>
              <div class="card" data-r="coverage"></div>
            </div>
          </div>`;
        renderHead();
        renderRefs();
        renderSheet();
        renderCoverage();
        voices().then((v) => {
            const sel = root.querySelector('[data-f="voice"]');
            if (!sel || S.c?.id !== c.id) return;
            const cur = S.c.voice?.voiceId || '';
            const opts = v.list.map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
            sel.innerHTML = v.available ? `<option value="">No voice</option>${opts}${cur && !v.list.some((x) => x.id === cur) ? `<option value="${esc(cur)}" selected>${esc(S.c.voice?.name || cur)}</option>` : ''}` : '<option value="">Connect ElevenLabs in Providers</option>';
            sel.disabled = !v.available;
        });
    }

    function renderLive() { renderHead(); renderRefs(); renderSheet(); renderCoverage(); renderSide(); }

    function renderHead() {
        const el = root.querySelector('[data-r="head"]');
        if (!el || !S.c) return;
        const c = S.c;
        const focused = el.contains(document.activeElement);
        if (focused) return;
        el.innerHTML = `
          <div class="chp-av lg" style="${c.coverUrl ? `background-image:url('${esc(c.coverUrl)}')` : ''}">${c.coverUrl ? '' : initial(c.name)}</div>
          <div class="col grow" style="gap:2px;min-width:0">
            <input class="name" type="text" data-f="name" value="${esc(c.name)}" aria-label="Character name"/>
            <span class="muted" style="font-size:12px">${c.refs.filter((r) => r.kind !== 'sheet').length} references · ${c.coverage?.percent ?? 0}% of the photo spec${c.approvedSheet ? ' · approved sheet leads every generation' : ''}${c.voice ? ' · voice set' : ''}</span>
          </div>
          <button class="btn ghost sm" data-a="delete">Delete</button>`;
    }

    function refCard(r) {
        const score = r.quality?.score;
        const analyzing = r.status === 'analyzing';
        const issues = r.quality?.issues || [];
        return `<div class="chp-ref ${r.kind === 'sheet' ? 'sheet' : ''}">
          <div class="ph" style="background-image:url('${esc(r.url)}')">
            <div class="tl"><span class="tag">${KIND[r.kind] || r.kind}${r.t != null ? ` <span style="text-transform:none">@${r.t.toFixed(1)}s</span>` : ''}</span></div>
            <div class="tr">${analyzing ? '<span class="score na"><span class="spin" style="width:9px;height:9px"></span></span>' : `<span class="score ${scoreCls(score)}" title="Reference quality">${score ?? '–'}</span>`}</div>
            <button class="x" data-a="del-ref" data-id="${esc(r.assetId)}" title="Remove">✕</button>
          </div>
          <div class="bd">
            ${r.kind === 'sheet' ? '<span class="ok">Approved model sheet — sent first to every model</span>' : `
            <select data-ref-angle="${esc(r.assetId)}" ${analyzing ? 'disabled' : ''}>${ANGLES.map(([v, l]) => `<option value="${v}" ${r.angle === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <div class="an">${analyzing ? 'Grading…' : esc([EXPR[r.expression] || '', r.expressionLabel && r.expression === 'other' ? r.expressionLabel : '', r.framing?.replace(/-/g, ' '), r.cameraHeight === 'below-eye-level' ? 'low angle' : ''].filter(Boolean).join(' · '))}</div>
            ${issues.length ? `<ul>${issues.slice(0, 4).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : analyzing ? '' : '<span class="ok">✓ Clean reference</span>'}
            ${r.error ? `<span class="dim" style="font-size:10.5px">${esc(r.error)}</span>` : ''}`}
          </div></div>`;
    }

    function renderRefs() {
        const el = root.querySelector('[data-r="refs"]');
        if (!el || !S.c) return;
        const c = S.c;
        const refs = [...c.refs].sort((a, b) => (a.kind === 'sheet' ? -1 : b.kind === 'sheet' ? 1 : (b.quality?.score ?? -1) - (a.quality?.score ?? -1)));
        const lastVid = (c.videos || []).at(-1);
        const ungraded = c.refs.filter((r) => r.kind !== 'sheet' && !r.graded && r.status !== 'analyzing').length;
        el.innerHTML = `
          <div class="sec-hd"><h3>References</h3><span class="dim" style="font-size:11.5px">best first · scores combine sharpness with a vision check</span><span class="grow"></span>${ungraded ? `<button class="btn sm ghost" data-a="regrade">Re-check ${ungraded}</button>` : ''}</div>
          <div class="chp-drop" data-a="pick" data-drop>
            <div class="ic">⇪</div>
            <div><b>Drop photos or a short video</b><span>Rear camera, 1.5–2 m, 2× lens, even light, no filters — or a 10–15 s tripod head-turn video; the best frames are picked for you.</span></div>
          </div>
          ${S.uploading ? `<div class="chp-proc"><span class="spin"></span>${esc(S.uploading)}</div>` : ''}
          ${(c.processing || []).map((p) => `<div class="chp-proc"><span class="spin"></span>Video: ${esc(p.message || 'processing')}</div>`).join('')}
          ${lastVid && !c.processing?.length ? `<p class="dim" style="font-size:11.5px;margin-top:8px">${lastVid.error ? `Last video failed: ${esc(lastVid.error)}` : `Last video: kept ${lastVid.kept} of ${lastVid.frames} frames (${lastVid.graded} graded).`}</p>` : ''}
          ${refs.length ? `<div class="chp-refs">${refs.map(refCard).join('')}</div>` : '<p class="muted" style="margin-top:12px;font-size:12px">No references yet.</p>'}`;
    }

    function renderCoverage() {
        const el = root.querySelector('[data-r="coverage"]');
        if (!el || !S.cov) return;
        const cov = S.cov;
        el.innerHTML = `
          <div class="sec-hd"><h3>Photo coverage</h3><span class="grow"></span><span class="chp-pct">${cov.percent}%</span></div>
          <div class="chp-cov">${Object.keys(cov.have).map((k) => `<div class="chp-slot ${cov.have[k] ? 'ok' : ''}" title="${esc(cov.slotTips[k])}"><i>✓</i>${esc(cov.labels[k])}</div>`).join('')}</div>
          ${cov.tips.length ? `<ul class="chp-tips">${cov.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="muted" style="margin-top:10px;font-size:12px">Every angle in the spec is covered. 🎉</p>'}
          <details class="chp-guide" style="margin-top:12px"><summary>How to shoot reference photos</summary><ul class="chp-tips">${cov.guide.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>`;
    }

    function renderSheet() {
        const el = root.querySelector('[data-r="sheet"]');
        if (!el || !S.c) return;
        const c = S.c;
        const s = c.sheet;
        const running = S.sheetJob || c.sheetJob;
        const photos = c.refs.filter((r) => r.kind !== 'sheet').length;
        el.innerHTML = `
          <div class="sec-hd"><h3>Model sheet</h3><span class="dim" style="font-size:11.5px">front · ¾ · profile · full body on a neutral background (Nano Banana Pro)</span></div>
          ${s ? `<div class="chp-sheet"><img src="${esc(s.url)}" alt="Model sheet"/><span class="badge chip ${s.approved ? 'ok' : 'warn'}"><i></i>${s.approved ? 'Approved — first reference everywhere' : 'Review: approve if it is really them'}</span></div>` : `<p class="muted" style="font-size:12px;line-height:1.55">A generated turnaround on a plain background, honouring your look notes. Once you approve it, it becomes the first reference for every image and video model — that measurably improves likeness.</p>`}
          ${s && !s.approved && c.approvedSheet ? '<p class="dim" style="font-size:11.5px;margin-top:8px">Your earlier approved sheet keeps leading every generation until you approve this one.</p>' : ''}
          ${c.sheetError && !running ? `<p style="color:var(--eg-bad);font-size:12px;margin-top:8px">${esc(c.sheetError)}</p>` : ''}
          <div class="row" style="margin-top:10px;flex-wrap:wrap">
            ${running ? `<button class="btn" disabled><span class="spin"></span> ${esc(S.sheetJob?.message || 'Generating')}</button>` : `<button class="btn ${s ? '' : 'primary'}" data-a="sheet" ${photos ? '' : 'disabled title="Add photos first"'}>${s ? '↻ Regenerate' : '✦ Generate sheet'}</button>`}
            ${s && !running ? (s.approved ? '<button class="btn ghost" data-a="unapprove">Unapprove</button>' : '<button class="btn primary" data-a="approve">✓ Approve</button>') : ''}
            ${s ? `<a class="btn ghost sm" href="${esc(s.url)}" download>↓</a>` : ''}
          </div>`;
    }

    /* ---------------- events ---------------- */

    root.addEventListener('click', async (e) => {
        const el = e.target.closest('[data-a]');
        if (!el) return;
        const a = el.dataset.a;
        try {
            switch (a) {
                case 'new': {
                    await flush();
                    const c = await engine.post('/characters', { name: 'New character' });
                    await loadList(c.id);
                    const n = root.querySelector('[data-f="name"]');
                    n?.focus();
                    n?.select();
                    return;
                }
                case 'open': await flush(); return open(el.dataset.id, { full: true });
                case 'pick': fileInput.value = ''; fileInput.click(); return;
                case 'del-ref':
                    if (!confirm('Remove this reference?')) return;
                    await engine.del(`/characters/${S.c.id}/refs/${el.dataset.id}`);
                    return open(S.c.id);
                case 'regrade': await engine.post(`/characters/${S.c.id}/analyze`, {}); return open(S.c.id);
                case 'sheet': {
                    await flush();
                    const { jobId } = await engine.post(`/characters/${S.c.id}/sheet`, {});
                    watchSheet(jobId);
                    toast('Generating the model sheet — about 30–60 s');
                    return;
                }
                case 'approve': await engine.post(`/characters/${S.c.id}/sheet/approve`, {}); toast('Sheet approved — it now leads every generation'); return open(S.c.id);
                case 'unapprove': await engine.post(`/characters/${S.c.id}/sheet/approve`, { approved: false }); return open(S.c.id);
                case 'delete':
                    if (!confirm(`Delete ${S.c.name}? Photos stay in your library.`)) return;
                    await engine.del(`/characters/${S.c.id}`);
                    localStorage.removeItem('char_current');
                    S.c = null;
                    return loadList();
            }
        } catch (err) { toast(err.message, true); }
    });

    root.addEventListener('input', (e) => {
        const f = e.target.dataset.f;
        if (!f || f === 'voice' || f === 'realPerson' || !S.c) return;
        patch({ [f]: e.target.value });
    });

    root.addEventListener('change', async (e) => {
        const el = e.target;
        if (el.dataset.f === 'realPerson') { patch({ realPerson: el.checked }); return flush(); }
        if (el.dataset.f === 'voice') {
            const v = S.voices?.list.find((x) => x.id === el.value);
            patch({ voice: el.value ? { provider: 'eleven', voiceId: el.value, name: v?.name || '' } : null });
            return flush();
        }
        if (el.dataset.refAngle) {
            try { await engine.patch(`/characters/${S.c.id}/refs/${el.dataset.refAngle}`, { angle: el.value }); await open(S.c.id); } catch (err) { toast(err.message, true); }
        }
    });

    fileInput.addEventListener('change', () => uploadFiles(fileInput.files));
    root.addEventListener('dragover', (e) => { if (!S.c) return; e.preventDefault(); root.querySelector('[data-drop]')?.classList.add('over'); });
    root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.querySelector('[data-drop]')?.classList.remove('over'); });
    root.addEventListener('drop', (e) => {
        if (!S.c) return;
        e.preventDefault();
        root.querySelector('[data-drop]')?.classList.remove('over');
        uploadFiles(e.dataTransfer.files);
    });

    root.insertAdjacentHTML('beforeend', '<main class="chp-main"><div class="muted"><span class="spin"></span> Loading…</div></main>');
    loadList().catch((e) => toast(e.message, true));
    return root;
}
