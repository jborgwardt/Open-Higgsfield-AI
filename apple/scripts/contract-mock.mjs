// UI-test stand-in for the Characters and Tools APIs (built by other agents) so the app's screens can be
// exercised before those routes ship. Implements the agreed contracts in memory and proxies every
// other request to a real local engine. Generations use the free offline `local` models only.
//   node apple/scripts/contract-mock.mjs <port> <engine-base>     e.g. 4962 http://127.0.0.1:4961
import http from 'node:http';

const PORT = Number(process.argv[2]) || 4962;
const UP = process.argv[3] || 'http://127.0.0.1:4961';
const ANGLES = ['front', 'threeQuarterLeft', 'threeQuarterRight', 'profileLeft', 'profileRight', 'smile', 'expression', 'lowAngle', 'fullBody'];
const characters = new Map();
const now = () => new Date().toISOString();
let seq = 0;

const up = async (method, path, body) => {
  const r = await fetch(`${UP}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const assetUrl = async (id) => (await up('GET', '/engine/api/media')).find((a) => a.id === id)?.url || null;

const TOOLS = [
  { id: 'restyle', title: 'Restyle', sfSymbol: 'paintbrush.pointed', category: 'Effects', description: 'Re-imagine a photo in another look.',
    inputs: [
      { key: 'image', type: 'image', label: 'Photo', required: true, help: 'The picture to restyle.' },
      { key: 'style', type: 'select', label: 'Style', options: [{ value: 'noir', label: 'Film noir' }, { value: 'anime', label: 'Anime' }, { value: 'oil', label: 'Oil painting' }], default: 'noir', required: true },
      { key: 'strength', type: 'number', label: 'Strength', min: 0, max: 1, default: 0.6 },
    ], run: { method: 'POST', path: '/tools/restyle/run' }, output: 'image' },
  { id: 'talking-avatar', title: 'Talking Avatar', sfSymbol: 'person.wave.2', category: 'Characters', description: 'Make a character say a line, lip-synced.',
    inputs: [
      { key: 'character', type: 'character', label: 'Character', required: true },
      { key: 'line', type: 'longtext', label: 'Line', required: true, help: 'What they say.' },
      { key: 'voice', type: 'voice', label: 'Voice' },
      { key: 'model', type: 'model', label: 'Video model', modelKind: 'video' },
      { key: 'subtitles', type: 'toggle', label: 'Burn in subtitles' },
    ], run: { method: 'POST', path: '/tools/talking-avatar/run' }, output: 'video' },
  { id: 'upscale', title: 'Upscale', sfSymbol: 'arrow.up.left.and.arrow.down.right', category: 'Effects', description: 'Sharper, bigger stills.',
    inputs: [{ key: 'image', type: 'image', label: 'Image', required: true }, { key: 'factor', type: 'select', label: 'Factor', options: ['2', '4'], default: '2' }],
    run: { method: 'POST', path: '/tools/upscale/run' }, output: 'image' },
];

async function refreshSheets() {
  for (const c of characters.values()) {
    if (!c._sheetJob) continue;
    const j = await up('GET', `/engine/api/jobs/${c._sheetJob}`).catch(() => null);
    if (j?.status === 'done') { c.sheet = { assetId: j.assetId, url: j.url, approved: false }; c._sheetJob = null; c.coverUrl = c.coverUrl || j.url; }
  }
}
const view = ({ _sheetJob, ...c }) => c;

async function handle(req, res, body) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/engine\/api/, '');
  const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  let m;
  if (p === '/characters' && req.method === 'GET') { await refreshSheets(); return send(200, [...characters.values()].map(view)); }
  if (p === '/characters' && req.method === 'POST') {
    const c = { id: `ch_${++seq}`, name: body.name || 'Unnamed', description: body.description || '', lookNotes: body.lookNotes || '', voice: null, refs: [], sheet: null, coverUrl: null, createdAt: now(), updatedAt: now() };
    characters.set(c.id, c);
    return send(200, view(c));
  }
  if ((m = p.match(/^\/characters\/([^/]+)$/))) {
    const c = characters.get(decodeURIComponent(m[1]));
    if (!c) return send(404, { error: 'character not found' });
    if (req.method === 'PATCH') { for (const k of ['name', 'description', 'lookNotes', 'voice']) if (k in body) c[k] = body[k]; c.updatedAt = now(); return send(200, view(c)); }
    if (req.method === 'DELETE') { characters.delete(c.id); return send(200, { ok: true }); }
  }
  if ((m = p.match(/^\/characters\/([^/]+)\/refs$/)) && req.method === 'POST') {
    const c = characters.get(decodeURIComponent(m[1]));
    if (!c) return send(404, { error: 'character not found' });
    for (const id of body.assetIds || []) {
      const u = await assetUrl(id);
      const i = c.refs.length;
      const score = [0.91, 0.78, 0.52, 0.86, 0.38, 0.8, 0.7, 0.65, 0.88][i % 9];
      c.refs.push({ assetId: id, url: u, kind: 'photo', angle: body.angle || ANGLES[i % ANGLES.length], quality: { score, sharp: score > 0.5, issues: score < 0.5 ? ['blurry'] : score < 0.6 ? ['backlit'] : [] } });
    }
    c.coverUrl = c.coverUrl || c.refs[0]?.url || null;
    return send(200, view(c));
  }
  if ((m = p.match(/^\/characters\/([^/]+)\/refs\/([^/]+)$/)) && req.method === 'DELETE') {
    const c = characters.get(decodeURIComponent(m[1]));
    if (c) c.refs = c.refs.filter((r) => r.assetId !== decodeURIComponent(m[2]));
    return send(200, { ok: true });
  }
  if ((m = p.match(/^\/characters\/([^/]+)\/coverage$/))) {
    const c = characters.get(decodeURIComponent(m[1]));
    if (!c) return send(404, { error: 'character not found' });
    const have = Object.fromEntries(ANGLES.map((a) => [a, c.refs.some((r) => r.angle === a)]));
    const missing = ANGLES.filter((a) => !have[a]);
    return send(200, { have, missing, tips: missing.length ? [`Still missing: ${missing.length} angle${missing.length === 1 ? '' : 's'}. Profiles help the most.`] : ['Great coverage.'] });
  }
  if ((m = p.match(/^\/characters\/([^/]+)\/sheet$/)) && req.method === 'POST') {
    const c = characters.get(decodeURIComponent(m[1]));
    const j = await up('POST', '/engine/api/generate', { model: 'local/plate', prompt: `Character sheet: ${c?.name}`, aspect_ratio: '16:9' });
    if (c) c._sheetJob = j.id;
    return send(200, { jobId: j.id });
  }
  if ((m = p.match(/^\/characters\/([^/]+)\/sheet\/approve$/))) {
    const c = characters.get(decodeURIComponent(m[1]));
    if (c?.sheet) c.sheet.approved = true;
    return send(200, { ok: true });
  }
  if (p === '/tools') return send(200, TOOLS);
  if ((m = p.match(/^\/tools\/([^/]+)\/run$/))) {
    const t = TOOLS.find((x) => x.id === m[1]);
    if (!t) return send(404, { error: 'no such tool' });
    const video = t.output === 'video';
    const j = await up('POST', '/engine/api/generate', { model: video ? 'local/animatic' : 'local/plate', prompt: `${t.title}: ${body.line || body.style || ''}`, image_url: body.image || undefined, aspect_ratio: '16:9', duration: 4 });
    return send(200, { jobId: j.id });
  }
  return false;
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  if (/^\/engine\/api\/(characters|tools)(\/|$)/.test(new URL(req.url, 'http://x').pathname)) {
    let body = {};
    try { body = raw.length ? JSON.parse(raw) : {}; } catch {}
    try { if ((await handle(req, res, body)) !== false) return; } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
  }
  const target = new URL(req.url, UP);
  const pr = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  pr.on('error', (e) => { res.writeHead(502); res.end(e.message); });
  pr.end(raw);
}).listen(PORT, '127.0.0.1', () => console.log(`contract mock on http://127.0.0.1:${PORT} → ${UP}`));
