// Runs the local engine and the Vite dev server together (npm run dev:local).
import { spawn } from 'node:child_process';

const procs = [
  ['engine', process.execPath, ['engine/server.js']],
  ['vite', process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', process.env.PORT || '5173', '--strictPort']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = (d) => d.toString().split('\n').filter(Boolean).map((l) => `[${name}] ${l}`).join('\n') + '\n';
  p.stdout.on('data', (d) => process.stdout.write(tag(d)));
  p.stderr.on('data', (d) => process.stderr.write(tag(d)));
  p.on('exit', (code) => { console.log(`[${name}] exited ${code}`); shutdown(code || 0); });
  return p;
});

function shutdown(code) {
  for (const p of procs) if (p.exitCode === null) p.kill();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
