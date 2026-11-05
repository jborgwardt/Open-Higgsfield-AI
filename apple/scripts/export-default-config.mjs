// Writes the engine's app-config defaults into the app bundle, so a first launch without network
// behaves exactly like the server's defaults. Run after changing APP_DEFAULTS in engine/lib/appconfig.js:
//   node apple/scripts/export-default-config.mjs
// (test-app-config.mjs fails if the two drift apart.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../FilmStudioKit/Sources/FilmStudioKit/Resources/default-app-config.json');

export async function engineDefaults() {
  process.env.ENGINE_DATA ||= fs.mkdtempSync(path.join(os.tmpdir(), 'filmstudio-defaults-'));
  const { APP_DEFAULTS } = await import('../../engine/lib/appconfig.js');
  return APP_DEFAULTS;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(await engineDefaults(), null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}
