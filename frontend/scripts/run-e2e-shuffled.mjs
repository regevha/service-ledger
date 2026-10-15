// Runs the Playwright e2e suite with the spec files in a random order.
//
// Why: the specs share one backend and one database, so a spec that quietly
// depends on another spec's leftovers only fails when the order changes. A
// fixed order never shows that. Playwright has no shuffle option, so this
// copies tests/e2e to tests/e2e_shuffled with a numeric prefix in front of
// each spec file (Playwright runs files in name order, one worker), runs the
// suite from there, and deletes the copy again.
//
// The seed is printed. To replay a failing order exactly:
//   E2E_SHUFFLE_SEED=<seed> npm run test:e2e:shuffled
// Extra arguments go to `playwright test`, e.g. a spec name or --grep.
import { spawn } from 'node:child_process';
import { cpSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'tests', 'e2e');
const shuffled = join(root, 'tests', 'e2e_shuffled');

const seedText = process.env.E2E_SHUFFLE_SEED;
const seed = seedText ? Number(seedText) >>> 0 : Math.floor(Math.random() * 2 ** 32) >>> 0;
if (!Number.isFinite(seed)) {
  console.error(`E2E_SHUFFLE_SEED must be a number, got "${seedText}"`);
  process.exit(2);
}

// mulberry32: small seeded generator, so the same seed gives the same order.
function random(state) {
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

rmSync(shuffled, { recursive: true, force: true });
cpSync(source, shuffled, { recursive: true });

const specs = readdirSync(shuffled).filter((name) => name.endsWith('.spec.ts')).sort();
const next = random(seed);
for (let i = specs.length - 1; i > 0; i--) {
  const j = Math.floor(next() * (i + 1));
  [specs[i], specs[j]] = [specs[j], specs[i]];
}
const width = String(specs.length).length;
specs.forEach((name, i) => {
  renameSync(join(shuffled, name), join(shuffled, `${String(i).padStart(width, '0')}-${name}`));
});

console.log(`e2e shuffle seed: ${seed}   (replay: E2E_SHUFFLE_SEED=${seed} npm run test:e2e:shuffled)`);
console.log(`spec order: ${specs.join(', ')}`);

const cleanup = () => rmSync(shuffled, { recursive: true, force: true });
const child = spawn(
  'npx',
  ['playwright', 'test', '-c', 'playwright.shuffled.config.ts', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  cleanup();
  if (code === 0) {
    console.log(`e2e shuffle seed ${seed}: passed`);
  } else {
    console.error(`e2e shuffle seed ${seed}: FAILED. Replay with E2E_SHUFFLE_SEED=${seed} npm run test:e2e:shuffled`);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
