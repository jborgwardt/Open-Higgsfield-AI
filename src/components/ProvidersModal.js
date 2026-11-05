import '../styles/engine.css';
import { engine } from '../lib/engine.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Providers & accounts for the local engine. Keys are posted to the engine, stored in
 * engine-data/settings.json on this machine, and never returned to the browser.
 */
export function ProvidersModal() {
    document.querySelector('.eg-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'eg-overlay eg';
    overlay.innerHTML = '<div class="eg-modal"><div class="bd muted"><span class="spin"></span> Loading providers…</div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    let pollTimer = null;
    const close = () => { clearTimeout(pollTimer); overlay.remove(); };

    const chip = (ok, okText, offText, cls = 'ok') => `<span class="chip ${ok ? cls : ''}"><i></i>${esc(ok ? okText : offText)}</span>`;
    const secret = (name, st, placeholder) => `<input type="password" name="${name}" autocomplete="off" ${st?.env ? 'disabled' : ''} placeholder="${st?.env ? 'set via environment variable' : st?.set ? '•••••••• saved — type to replace' : esc(placeholder)}" />`;

    async function render() {
        const [s, st] = await Promise.all([engine.get('/settings'), engine.get('/status')]);
        const x = st.xai;
        const p = st.providers;
        overlay.querySelector('.eg-modal').innerHTML = `
          <div class="hd"><h2>Providers & accounts</h2><button class="btn ghost" data-a="close">✕</button></div>
          <form class="bd" autocomplete="off">
            <p class="muted" style="font-size:12px">Connect any mix of providers. Every connected model shows up in the Image, Video, Cinema and Long-form studios. Keys stay on this machine in <code>engine-data/settings.json</code>.</p>

            <div class="card prov col">
              <h4>xAI · Grok Imagine ${x.connected ? chip(true, `SuperGrok · ${x.email || 'connected'}`, '') : x.apiKey ? chip(true, 'API key', '') : chip(false, '', 'not connected')}</h4>
              <p>Sign in with your <b>SuperGrok / X Premium</b> account — xAI's official device sign-in (the same one OpenCode, Warp and Crush use). You approve on accounts.x.ai; your password never touches this app. Video/image generation through the subscription depends on what xAI includes in your plan; if a call is refused, add an API key as fallback.</p>
              ${x.pending ? `<div class="code-box"><b>${esc(x.pending.userCode)}</b><div class="col grow"><span>Open <a href="${esc(x.pending.verificationUri)}" target="_blank" rel="noopener">${esc(x.pending.verificationUri.replace(/^https?:\/\//, '').split('?')[0])}</a> and enter this code.</span><span class="muted"><span class="spin"></span> Waiting for approval…</span></div></div>` : ''}
              ${x.error ? `<p style="color:var(--eg-bad)">${esc(x.error)}</p>` : ''}
              <div class="row">
                ${x.connected ? '<button type="button" class="btn sm" data-a="xai-logout">Sign out of SuperGrok</button>' : `<button type="button" class="btn sm primary" data-a="xai-login">${x.pending ? 'New code' : 'Sign in with SuperGrok'}</button>`}
                <button type="button" class="btn sm" data-a="test" data-p="xai" ${p.xai.available ? '' : 'disabled'}>Test</button>
                <label class="toggle" style="margin-left:auto"><input type="checkbox" name="xaiPreferSubscription" ${s.xaiPreferSubscription ? 'checked' : ''}/> Prefer subscription over API key</label>
              </div>
              ${secret('xaiKey', s.xaiKey, 'xAI API key (optional, metered) — console.x.ai')}
              <span class="muted" data-test="xai"></span>
            </div>

            <div class="card prov col">
              <h4>Google · Gemini API ${chip(p.google.available, 'key set', 'no key')}</h4>
              <p><b>Gemini Omni Flash</b> video (with audio, first/last frame, multi-turn extension) and <b>Nano Banana</b> keyframes. Your <b>Google AI Ultra</b> plan includes <b>$100/month of Google Cloud credits</b> that pay for these API calls:</p>
              <ol class="steps">
                <li>Activate your benefits at <a href="https://developers.google.com/program" target="_blank" rel="noopener">developers.google.com/program</a> (sign in with the Ultra account).</li>
                <li>Apply the monthly credits to a Cloud billing account and link it to a project.</li>
                <li>Create a key for that project at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and paste it here.</li>
              </ol>
              <p class="dim">Video you make inside Flow or the Gemini app uses separate in-app credits that Google doesn't expose to APIs — use the <b>Hand-off: Google Flow</b> model in Long-form to bring those clips in.</p>
              <div class="row">${secret('googleKey', s.googleKey, 'Gemini API key (AIza…)')}<button type="button" class="btn sm" data-a="test" data-p="google" ${p.google.available ? '' : 'disabled'}>Test</button></div>
              <span class="muted" data-test="google"></span>
            </div>

            <div class="card prov col">
              <h4>ApiMart ${chip(p.apimart?.available, 'key set', 'no key')}</h4>
              <p>One key for premium video — <b>Veo 3.1 Quality / Fast</b>, <b>Kling 3.0 / V4</b>, <b>Seedance 2.0 / 2.5</b>, <b>Wan 2.6 / 3.0</b> — plus hundreds of chat models you can use as the <b>Director</b> below. Billed to your ApiMart balance.</p>
              <div class="row">${secret('apimartKey', s.apimartKey, 'ApiMart key (sk-…) — apimart.ai')}<button type="button" class="btn sm" data-a="test" data-p="apimart" ${p.apimart?.available ? '' : 'disabled'}>Test</button></div>
              <span class="muted" data-test="apimart"></span>
            </div>

            <div class="card prov col">
              <h4>ElevenLabs · narration ${chip(st.eleven?.available, 'key set', 'no key')}</h4>
              <p>Narrate long-form films in your own cloned voice or any ElevenLabs voice. Pick it under <b>Sound → Voice from</b> in a production; uses your ElevenLabs plan's credits.</p>
              <div class="row">${secret('elevenKey', s.elevenKey, 'ElevenLabs API key')}<label class="f" style="width:auto"><span>Voice model</span><select name="elevenModel">${(st.eleven?.models || ['eleven_v4']).map((m) => `<option ${m === s.elevenModel ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label><button type="button" class="btn sm" data-a="test" data-p="eleven" ${st.eleven?.available ? '' : 'disabled'}>Test</button></div>
              <span class="muted" data-test="eleven"></span>
            </div>

            <div class="grid2">
              <div class="card prov col"><h4>fal.ai ${chip(p.fal.available, 'key set', 'no key')}</h4><p>Wan 2.2, LTX-Video, FLUX, Kontext (open weights).</p>${secret('falKey', s.falKey, 'fal key')}</div>
              <div class="card prov col"><h4>Replicate ${chip(p.replicate.available, 'token set', 'no token')}</h4><p>Wan 2.2 Fast, FLUX schnell.</p>${secret('replicateToken', s.replicateToken, 'r8_…')}</div>
              <div class="card prov col"><h4>muapi.ai ${chip(p.muapi.available, 'key set', 'no key')}</h4><p>Veo 3.1, Kling 3.0, Seedance, Wan 2.6 via muapi.</p>${secret('muapiKey', s.muapiKey, 'muapi key')}</div>
              <div class="card prov col"><h4>kie.ai ${chip(p.kie.available, 'key set', 'no key')}</h4><p>Veo 3 Fast, Seedance 2, Kling 3, Nano Banana 2.</p>${secret('kieKey', s.kieKey, 'kie key')}</div>
            </div>

            <div class="card prov col">
              <h4>ComfyUI · self-hosted ${chip(st.comfy, 'online', 'offline')}</h4>
              <p>Runs the API-format workflows in <code>engine/comfy/</code> (FLUX, Kontext, Wan 2.2 5B) on your own GPU box.</p>
              <input type="url" name="comfyUrl" value="${esc(s.comfyUrl)}" placeholder="http://127.0.0.1:8188" />
            </div>

            <div class="card prov col">
              <h4>Director (script → shot list) ${chip(!!st.director, { xai: 'Grok', google: 'Gemini', apimart: 'ApiMart', openai: 'local LLM' }[st.director] || '', 'offline splitter', 'ok')}</h4>
              <p>Long-form uses an LLM to break your script into scenes and shots. <b>Auto</b> picks Grok (SuperGrok), then Gemini, then ApiMart, then an OpenAI-compatible server such as Ollama or LM Studio. With <b>ApiMart</b> the model defaults to <code>claude-haiku-5-5</code>.</p>
              <div class="grid3">
                <label class="f"><span>Director</span><select name="directorProvider">${['auto', 'xai', 'google', 'apimart', 'openai'].map((v) => `<option value="${v}" ${s.directorProvider === v ? 'selected' : ''}>${{ auto: 'Auto', xai: 'Grok (xAI)', google: 'Gemini', apimart: 'ApiMart', openai: 'OpenAI-compatible' }[v]}</option>`).join('')}</select></label>
                <label class="f"><span>Model <em>optional</em></span><input type="text" name="directorModel" value="${esc(s.directorModel)}" placeholder="auto" list="eg-director" /><datalist id="eg-director">${(st.directorModels?.apimart || []).map((m) => `<option value="${esc(m)}">ApiMart</option>`).join('')}</datalist></label>
                <label class="f"><span>Local LLM model</span><input type="text" name="llmModel" value="${esc(s.llmModel)}" list="eg-llm" /><datalist id="eg-llm">${(st.llm.models || []).map((m) => `<option value="${esc(m)}">`).join('')}</datalist></label>
              </div>
              <div class="grid2"><input type="url" name="llmBaseUrl" value="${esc(s.llmBaseUrl)}" placeholder="http://127.0.0.1:11434/v1" />${secret('llmKey', s.llmKey, 'API key (optional for local servers)')}</div>
            </div>

            <div class="card prov col">
              <h4>Subscription hand-off folder</h4>
              <p>When a Long-form shot uses a hand-off model, generate it yourself in Flow or grok.com/imagine and download it — new videos landing in this folder are attached to the waiting shots in order.</p>
              <input type="text" name="handoffDir" value="${esc(s.handoffDir)}" />
            </div>
            ${st.ffmpeg ? '' : '<p style="color:var(--eg-bad)">ffmpeg is not installed — long-form assembly needs it (<code>brew install ffmpeg</code>).</p>'}
          </form>
          <div class="ft"><button class="btn" data-a="close">Close</button><button class="btn primary" data-a="save">Save</button></div>`;
        clearTimeout(pollTimer);
        // While a SuperGrok code is pending, watch only the login state so typing in the form isn't disturbed.
        if (x.pending) {
            const tick = async () => {
                if (!document.body.contains(overlay)) return;
                const ls = await engine.get('/xai/login').catch(() => null);
                if (ls && (!ls.pending || ls.connected || ls.error)) {
                    await engine.registerModels().catch(() => {});
                    window.dispatchEvent(new CustomEvent('engine:catalog-changed'));
                    render();
                } else pollTimer = setTimeout(tick, 3000);
            };
            pollTimer = setTimeout(tick, 3000);
        }
    }

    async function saveForm(announce = true) {
        const form = overlay.querySelector('form');
        if (!form) return;
        const body = {};
        for (const el of form.elements) {
            if (!el.name || el.disabled) continue;
            if (el.type === 'checkbox') body[el.name] = el.checked;
            else if (el.type === 'password') { if (el.value) body[el.name] = el.value; }
            else body[el.name] = el.value;
        }
        await engine.post('/settings', body);
        await engine.registerModels();
        window.dispatchEvent(new CustomEvent('engine:catalog-changed'));
        if (announce) toast('Providers saved — new models are in the studio pickers');
    }

    overlay.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) return;
        const a = b.dataset.a;
        try {
            if (a === 'close') close();
            else if (a === 'save') { b.disabled = true; await saveForm(); close(); }
            else if (a === 'xai-login') { b.disabled = true; await saveForm(false); await engine.post('/xai/login'); render(); }
            else if (a === 'xai-logout') { await engine.post('/xai/logout'); await engine.registerModels(); render(); }
            else if (a === 'test') {
                await saveForm(false);
                const out = overlay.querySelector(`[data-test="${b.dataset.p}"]`);
                out.innerHTML = '<span class="spin"></span> Testing…';
                try {
                    const r = await engine.post(`/test/${b.dataset.p}`);
                    out.innerHTML = `<span style="color:var(--eg-ok)">✓ ${esc(r.detail)}${r.via ? ` · billed via ${r.via === 'subscription' ? 'SuperGrok subscription' : 'API key'}` : ''}</span>`;
                } catch (err) { out.innerHTML = `<span style="color:var(--eg-bad)">✕ ${esc(err.message)}</span>`; }
            }
        } catch (err) { toast(err.message, true); b.disabled = false; }
    });

    render().catch((e) => { overlay.querySelector('.eg-modal').innerHTML = `<div class="bd" style="color:var(--eg-bad)">Engine unreachable: ${esc(e.message)}</div>`; });
    return overlay;
}

export function toast(msg, bad = false) {
    const t = document.createElement('div');
    t.className = 'eg';
    t.style.cssText = `position:fixed;right:18px;bottom:18px;z-index:300;max-width:420px;background:#18181b;border:1px solid rgba(255,255,255,.14);border-left:3px solid ${bad ? '#ff6b6b' : '#3ddc97'};border-radius:10px;padding:10px 13px;font-size:12.5px;color:#ececf1;box-shadow:0 12px 30px rgba(0,0,0,.5)`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), bad ? 8000 : 4000);
}
