// Seeds the contract mock with two characters (free `local/plate` stills as reference photos).
//   node apple/scripts/seed-characters.mjs http://127.0.0.1:4962
const BASE = `${process.argv[2] || 'http://127.0.0.1:4962'}/engine/api`;
const call = (method, path, body) => fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

async function still(prompt) {
  const job = await call('POST', '/generate', { model: 'local/plate', prompt, aspect_ratio: '3:4' });
  for (;;) {
    const j = await call('GET', `/jobs/${job.id}`);
    if (j.status === 'done') return j.assetId;
    if (j.status === 'error') throw new Error(j.error);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const bub = await call('POST', '/characters', { name: 'Bub', description: 'Tall, short beard, calm', lookNotes: 'Grey tee, dark jacket' });
const angles = ['front', 'threeQuarterLeft', 'profileRight', 'smile', 'fullBody'];
for (const a of angles) await call('POST', `/characters/${bub.id}/refs`, { assetIds: [await still(`Bub ${a}`)], angle: a });
await call('POST', '/characters', { name: 'Bubbie', description: 'Curly hair, bright smile' });
console.log(`seeded ${bub.id} with ${angles.length} refs`);
