// Client for the local engine (engine/server.js): extra providers, SuperGrok / Gemini access,
// long-form productions. Engine models appear in the studios' pickers with an "engine:" prefix.
import { t2iModels, i2iModels, t2vModels, i2vModels } from './models.js';

const BASE = '/engine/api';
let online = false;
let catalog = [];

async function req(method, path, body, { raw } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: raw ? { 'Content-Type': raw.type || 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {},
        body: raw ? raw.data : body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `${res.status} ${res.statusText}`), { status: res.status });
    return json;
}

export const engine = {
    get online() { return online; },
    get catalog() { return catalog; },
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b || {}),
    patch: (p, b) => req('PATCH', p, b),
    del: (p) => req('DELETE', p),

    needsLogin: false,

    async detect() {
        try {
            const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000), credentials: 'include' });
            const j = r.ok ? await r.json() : {};
            this.health = j;
            online = j.ok === true;
            this.needsLogin = online && j.auth && !j.authed;
        } catch { online = false; }
        if (online) localStorage.setItem('engine_on', '1'); else localStorage.removeItem('engine_on');
        return online;
    },

    /** Pull the engine catalog and merge available models into the studio model lists. */
    async registerModels() {
        if (!online) return;
        const { models } = await req('GET', '/catalog');
        catalog = models;
        const strip = (list) => { for (let i = list.length - 1; i >= 0; i--) if (String(list[i].id).startsWith('engine:')) list.splice(i, 1); };
        [t2iModels, i2iModels, t2vModels, i2vModels].forEach(strip);
        const ORDER = ['xai', 'google', 'apimart', 'fal', 'kie', 'muapi', 'replicate', 'comfy', 'local'];
        const adds = { t2i: [], i2i: [], t2v: [], i2v: [] };
        const sorted = [...models].sort((a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));
        for (const m of sorted) {
            if (!m.available || m.provider === 'handoff') continue;
            const base = {
                id: `engine:${m.id}`,
                label: `${m.label}`,
                name: `${m.label}`,
                kind: m.kind,
                api: 'engine',
                engine: true,
                provider: m.provider,
                blurb: `${m.blurb ? `${m.blurb} ` : ''}via ${m.provider}`,
                description: `${m.blurb ? `${m.blurb} ` : ''}via ${m.provider}`,
                aspects: m.aspects || ['16:9'],
                resolutions: m.resolutions || [],
                resolutionDefault: m.resolutionDefault || null,
            };
            if (m.kind === 'image') {
                adds.t2i.push(base);
                if (m.refs) adds.i2i.push({ ...base, images: { param: 'image', max: m.refs, required: true } });
            } else {
                const v = { ...base, durations: m.durations || [], hasDuration: !!m.durations?.length, images: m.caps?.i2v ? { param: 'image', max: 1, required: !m.caps?.t2v } : undefined };
                if (m.caps?.t2v) adds.t2v.push(v);
                if (m.caps?.i2v) adds.i2v.push(v);
            }
        }
        // Engine models go first (cloud before offline previs), the kie/content-factory list follows.
        t2iModels.unshift(...adds.t2i);
        i2iModels.unshift(...adds.i2i);
        t2vModels.unshift(...adds.t2v);
        i2vModels.unshift(...adds.i2v);
    },

    async login(token) {
        return req('POST', '/login', { token });
    },

    async logout() {
        await req('POST', '/logout', {});
        location.reload();
    },

    async upload(file) {
        const a = await req('POST', `/upload?name=${encodeURIComponent(file.name || 'upload')}`, null, { raw: { data: file, type: file.type || 'application/octet-stream' } });
        return a;
    },

    /** Run a studio generation through the engine; resolves like the kie client ({ url }). */
    async generate(params) {
        const job = await req('POST', '/generate', {
            model: params.model,
            prompt: params.prompt,
            image_url: params.image_url || params.images_list?.[0] || null,
            images_list: params.images_list?.slice(1) || [],
            end_image_url: params.end_image_url || null,
            aspect_ratio: params.aspect_ratio,
            duration: params.duration ? Number(params.duration) : undefined,
            resolution: params.resolution,
            seed: params.seed,
        });
        if (params.onRequestId) params.onRequestId(`engine:${job.id}`);
        return this.poll(job.id);
    },

    async poll(jobId, maxAttempts = 1800, interval = 2000) {
        const id = String(jobId).replace(/^engine:/, '');
        for (let i = 0; i < maxAttempts; i++) {
            const j = await req('GET', `/jobs/${id}`);
            if (j.status === 'done') return { ...j, url: j.url, id: j.assetId };
            if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.error || 'Generation failed');
            await new Promise((r) => setTimeout(r, interval));
        }
        throw new Error('Generation timed out');
    },
};

export const isEngineModel = (id) => String(id || '').startsWith('engine:');
