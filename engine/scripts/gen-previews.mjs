// Generate Home-feed preview media with Grok Imagine (free on the SuperGrok sign-in), inside the engine container.
//   node gen-previews.mjs <plan.json> <results.json> [--concurrency 3] [--only id,id] [--ingest]
// Resumable: items already in results.json with an assetId are skipped. Uses the engine API on loopback with the
// maintenance token from settings.json (ENGINE_DATA, default /data). --ingest then PATCHes /feed/previews so the
// engine transcodes each clip for mobile and records the mapping in the feed data file.
import fs from 'node:fs';
import path from 'node:path';

const [planFile, resultsFile] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CONC = Number(arg('--concurrency', 3));
const ONLY = arg('--only', '')?.split(',').filter(Boolean);
const DATA = process.env.ENGINE_DATA || '/data';
const BASE = process.env.ENGINE_URL || 'http://127.0.0.1:4848/engine/api';
const token = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')).accessToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : {};
const save = () => fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));

async function render(item) {
  const d = plan.defaults[item.kind];
  const model = item.model || d.model;
  if (!/^xai\//.test(model)) throw new Error(`refusing non-Grok model ${model}`); // previews are free on SuperGrok only
  const body = { model, prompt: item.prompt, aspect_ratio: item.aspect, ...(item.kind === 'video' ? { duration: item.duration || d.duration, resolution: item.resolution || d.resolution } : {}) };
  const job = await api('POST', '/generate', body);
  for (;;) {
    await sleep(4000);
    const j = await api('GET', `/jobs/${job.id}`);
    if (j.status === 'done') return { assetId: j.assetId, url: j.url, posterUrl: j.posterUrl, model, kind: item.kind, aspect: item.aspect };
    if (j.status !== 'running') throw new Error(j.error || j.status);
  }
}

const queue = plan.items.filter((i) => (!ONLY?.length || ONLY.includes(i.id)) && !results[i.id]?.assetId);
console.log(`${queue.length} to render (${plan.items.length - queue.length} done), concurrency ${CONC}`);
const failures = {};
await Promise.all(Array.from({ length: CONC }, async () => {
  for (let item; (item = queue.shift());) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        results[item.id] = { ...(await render(item)), at: new Date().toISOString(), attempts: attempt };
        delete failures[item.id];
        save();
        console.log(`ok   ${item.id} → ${results[item.id].assetId}`);
        break;
      } catch (e) {
        failures[item.id] = e.message;
        console.log(`fail ${item.id} (try ${attempt}): ${e.message}`);
        await sleep(5000 * attempt);
      }
    }
  }
}));
console.log(JSON.stringify({ done: Object.keys(results).length, failures }, null, 2));

if (process.argv.includes('--ingest')) {
  const items = Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { assetId: r.assetId }]));
  const out = await api('PATCH', '/feed/previews', { items });
  console.log(JSON.stringify(out.summary || out, null, 2));
}
