// Post-production UI: the "Enhance" dialog for any library video, and the long-form "Finishing" options.
// Everything runs on the engine (engine/lib/post.js) — subtitles via whisper.cpp, dialogue cleanup,
// mastering, picture enhancement; Topaz (fal) and ElevenLabs isolation only when chosen.
import '../styles/engine.css';
import { engine } from '../lib/engine.js';
import { toast } from './ProvidersModal.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LANGS = [['auto', 'Detect automatically'], ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'], ['tr', 'Turkish'], ['ja', 'Japanese'], ['zh', 'Chinese'], ['ko', 'Korean']];
const AUDIO = [['off', 'Leave as is'], ['clean', 'Remove background noise from speech (server)'], ['isolate', 'Voices only — ElevenLabs isolation (uses credits)']];
const opt = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');

/* ---------------- long-form brief: "Finishing" section ---------------- */

/** Extra brief controls rendered under the Sound section (data-b fields are saved by LongFormStudio). */
export function finishingSection(b) {
    const subs = b.subtitles || 'off';
    return `
      <div class="col" style="gap:8px;border-top:1px solid var(--eg-line);padding-top:12px">
        <h3 style="margin:0">Finishing</h3>
        <label class="f"><span>Subtitles <em>transcribed on the server</em></span><select data-b="subtitles">${opt([['off', 'None'], ['soft', 'Subtitle track (viewer can switch off)'], ['burn', 'Burned into the picture']], subs)}</select></label>
        ${subs !== 'off' ? `<label class="f"><span>Spoken language</span><select data-b="subtitleLanguage">${opt(LANGS, b.subtitleLanguage || 'auto')}</select></label>
          <label class="toggle"><input type="checkbox" data-b="translateSubtitles" ${b.translateSubtitles ? 'checked' : ''}/> Translate subtitles to English</label>` : ''}
        <label class="toggle"><input type="checkbox" data-b="colorMatch" ${b.colorMatch ? 'checked' : ''}/> Match colour &amp; exposure between shots of a scene</label>
        <label class="f"><span>Dialogue noise <em>only for noisy clips</em></span><select data-b="audioCleanup">${opt(AUDIO, b.audioCleanup || 'off')}</select></label>
        <details><summary class="dim" style="font-size:11.5px;cursor:pointer">More</summary><div class="col" style="gap:8px;margin-top:8px">
          <label class="f"><span>16 fps clips (Wan)</span><select data-b="smoothMotion">${opt([['auto', 'Motion-interpolate to 24 fps'], ['off', 'Repeat frames (faster)']], b.smoothMotion || 'auto')}</select></label>
          <label class="f"><span>Clips smaller than the master</span><select data-b="upscale">${opt([['off', 'Scale up (free)'], ['topaz', 'Topaz AI upscale on fal.ai (~$0.02/s at 1080p)']], b.upscale || 'off')}</select></label>
        </div></details>
        <p class="dim" style="font-size:11.5px">Applied when the master is assembled. The master is always levelled to −16 LUFS (two-pass). If a finishing step fails, the plain master still ships.</p>
      </div>`;
}

/** Subtitle track + download links for an assembled master. */
export function masterExtras(master) {
    const s = master?.subtitles;
    const l = master?.loudness;
    return {
        track: s?.vttUrl ? `<track kind="subtitles" src="${esc(s.vttUrl)}" srclang="${esc(s.language || 'und')}" label="Subtitles" ${s.mode === 'soft' ? 'default' : ''}/>` : '',
        links: [s?.srtUrl ? `<a class="btn sm ghost" href="${esc(s.srtUrl)}" download>↓ SRT</a>` : '', s?.jsonUrl ? `<a class="btn sm ghost" href="${esc(s.jsonUrl)}" target="_blank" rel="noopener">Transcript</a>` : ''].join(''),
        note: l && Number.isFinite(l.I) ? `${l.I.toFixed(1)} LUFS · ${Number.isFinite(l.TP) ? `${l.TP.toFixed(1)} dBTP` : ''}` : '',
    };
}

/* ---------------- Enhance dialog ---------------- */

export function EnhancePanel(item, onDone) {
    document.querySelector('.eg-overlay.pp')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'eg-overlay eg pp';
    overlay.style.zIndex = '210';
    overlay.innerHTML = '<div class="eg-modal" style="width:min(640px,100%)"><div class="bd muted"><span class="spin"></span> Loading…</div></div>';
    document.body.appendChild(overlay);
    let timer = null;
    const close = () => { clearTimeout(timer); overlay.remove(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const o = { subtitles: 'off', language: 'auto', translate: false, audio: 'off', loudness: true, denoise: false, smoothMotion: 'off', upscale: 'off' };
    let caps = null;
    let info = null;

    const field = (k, label, list, hint = '') => `<label class="f"><span>${label}${hint ? ` <em>${hint}</em>` : ''}</span><select data-o="${k}">${opt(list, o[k])}</select></label>`;
    function form() {
        const lowFps = info?.fps && info.fps < 23;
        const sizes = [['off', 'Keep size'], ...['1080p', '1440p', '2160p'].filter((s) => (info ? Math.min(info.width, info.height) < Number.parseInt(s, 10) : true)).map((s) => [s, s === '2160p' ? '4K (2160p)' : s])];
        return `
          <div class="hd"><h2>Enhance</h2><button class="btn ghost sm" data-x>✕</button></div>
          <div class="bd">
            <p class="muted" style="font-size:12px">${esc(item.model || 'Video')}${info ? ` · ${info.width}×${info.height} · ${info.fps ? `${Math.round(info.fps * 100) / 100} fps` : ''} · ${info.duration.toFixed(1)}s${info.hasAudio ? '' : ' · no audio'}` : ''}</p>
            ${caps && !caps.whisper ? '<p class="dim" style="font-size:11.5px">Subtitles need whisper.cpp on the engine host (included in the Docker image).</p>' : ''}
            <h3 style="margin:6px 0 0">Subtitles</h3>
            <div class="grid2">
              ${field('subtitles', 'Subtitles', [['off', 'None'], ['soft', 'Track (switchable)'], ['burn', 'Burn into picture']])}
              ${field('language', 'Spoken language', LANGS)}
            </div>
            ${o.subtitles !== 'off' ? `<label class="toggle"><input type="checkbox" data-o="translate" ${o.translate ? 'checked' : ''}/> Translate to English</label>` : ''}
            <h3 style="margin:6px 0 0">Sound</h3>
            ${field('audio', 'Dialogue noise', AUDIO, 'only for noisy recordings')}
            <label class="toggle"><input type="checkbox" data-o="loudness" ${o.loudness ? 'checked' : ''}/> Level loudness to −16 LUFS (two-pass, true peak −1.5 dB)</label>
            <h3 style="margin:6px 0 0">Picture</h3>
            <label class="toggle"><input type="checkbox" data-o="denoise" ${o.denoise ? 'checked' : ''}/> Remove grain / low-light noise <span class="dim">(slow: ~13 s per second of 1080p)</span></label>
            ${lowFps ? field('smoothMotion', `Frame rate (${Math.round(info.fps)} fps)`, [['off', 'Keep'], ['auto', 'Motion-interpolate to 24 fps']]) : ''}
            ${sizes.length > 1 ? field('upscale', 'Upscale (Topaz on fal.ai)', sizes, caps?.falUpscale ? '' : 'add a fal key in Providers') : ''}
            <p class="dim" data-est style="font-size:11.5px"></p>
            <div data-run></div>
          </div>
          <div class="ft"><button class="btn ghost" data-transcribe ${caps?.whisper && info?.hasAudio ? '' : 'disabled'}>Transcript only</button><span class="grow"></span><button class="btn" data-x>Cancel</button><button class="btn primary" data-go>Enhance</button></div>`;
    }

    async function estimate() {
        const el = overlay.querySelector('[data-est]');
        if (!el) return;
        try {
            const e = await engine.post('/post/estimate', { assetId: item.id, ...o });
            const parts = [];
            if (e.usd) parts.push(`fal.ai ≈ $${e.usd.toFixed(2)}`);
            if (e.elevenCredits) parts.push(`ElevenLabs ≈ ${e.elevenCredits.toLocaleString('en')} credits`);
            el.textContent = parts.length ? `Cloud cost: ${parts.join(' · ')}` : 'Runs entirely on the server — no cloud cost.';
        } catch { el.textContent = ''; }
    }

    function render() {
        overlay.querySelector('.eg-modal').innerHTML = form();
        estimate();
    }

    function poll(job, label) {
        const box = overlay.querySelector('[data-run]');
        overlay.querySelectorAll('[data-go],[data-transcribe]').forEach((b) => { b.disabled = true; });
        const tick = async () => {
            try {
                job = await engine.get(`/post/jobs/${job.id}`);
            } catch (e) { box.innerHTML = `<p class="muted" style="color:var(--eg-bad)">${esc(e.message)}</p>`; return; }
            const pct = Math.round((job.progress || 0) * 100);
            if (job.status === 'done') {
                const t = job.transcript;
                box.innerHTML = `<div class="card col" style="gap:8px">
                    ${job.url && job.kind === 'enhance' ? `<video src="${esc(job.url)}" controls playsinline style="width:100%;max-height:42vh;border-radius:10px;background:#000">${t?.vttUrl ? `<track kind="subtitles" src="${esc(t.vttUrl)}" srclang="${esc(t.language || 'und')}" label="Subtitles" default/>` : ''}</video>` : ''}
                    ${job.kind === 'transcribe' && t?.text ? `<textarea readonly rows="7" class="mono">${esc(t.text)}</textarea>` : ''}
                    <div class="row" style="flex-wrap:wrap">
                      <span class="chip ok"><i></i>${label} done</span>
                      ${job.loudness && Number.isFinite(job.loudness.I) ? `<span class="dim">${job.loudness.I.toFixed(1)} LUFS · ${job.loudness.TP.toFixed(1)} dBTP</span>` : ''}
                      <span class="grow"></span>
                      ${t?.srtUrl ? `<a class="btn sm ghost" href="${esc(t.srtUrl)}" download>↓ SRT</a><a class="btn sm ghost" href="${esc(t.vttUrl)}" download>↓ VTT</a>` : ''}
                      ${job.url && job.kind === 'enhance' ? `<a class="btn sm primary" href="${esc(job.url)}" download>↓ Video</a>` : ''}
                    </div></div>`;
                overlay.querySelectorAll('[data-go],[data-transcribe]').forEach((b) => { b.disabled = false; });
                onDone?.(job);
                return;
            }
            if (job.status === 'error' || job.status === 'cancelled') {
                box.innerHTML = `<p style="color:var(--eg-bad);font-size:12px">${esc(job.error || job.message)}</p>`;
                overlay.querySelectorAll('[data-go],[data-transcribe]').forEach((b) => { b.disabled = false; });
                return;
            }
            box.innerHTML = `<div class="col" style="gap:6px"><div class="row"><span class="spin"></span><span class="muted" style="font-size:12px">${esc(job.message || 'Working')}</span><span class="grow"></span><span class="dim mono">${pct}%</span><button class="btn sm ghost" data-cancel>Stop</button></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
            box.querySelector('[data-cancel]').onclick = () => engine.post(`/post/jobs/${job.id}/cancel`).catch(() => {});
            timer = setTimeout(tick, 1500);
        };
        tick();
    }

    overlay.addEventListener('click', async (e) => {
        if (e.target.closest('[data-x]')) return close();
        if (e.target.closest('[data-go]')) {
            try { poll(await engine.post('/post/enhance', { assetId: item.id, ...o }), 'Enhance'); } catch (err) { toast(err.message, true); }
        }
        if (e.target.closest('[data-transcribe]')) {
            try { poll(await engine.post('/post/transcribe', { assetId: item.id, language: o.language, translate: o.translate }), 'Transcript'); } catch (err) { toast(err.message, true); }
        }
    });
    overlay.addEventListener('change', (e) => {
        const k = e.target.dataset.o;
        if (!k) return;
        o[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        render();
    });

    Promise.all([engine.get('/post/capabilities').catch(() => null), engine.post('/post/estimate', { assetId: item.id }).catch(() => null)])
        .then(([c, e]) => { caps = c; info = e?.info || null; if (info?.fps && info.fps < 23) o.smoothMotion = 'auto'; render(); })
        .catch((err) => { toast(err.message, true); close(); });
    return overlay;
}
