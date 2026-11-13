import { createJiti } from 'jiti';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const jiti = createJiti(import.meta.url);
const PKG = '/home/ron/.nvm/versions/node/v27.0.0-alpha.0.0.0/lib/node_modules/@gotgenes/pi-permission-system/src';

// Scratch worktree W + outside files
const base = mkdtempSync(join(tmpdir(), 'p1-'));
const W = join(base, 'W');
mkdirSync(W, { recursive: true });
writeFileSync(join(W, 'a.txt'), 'inside');
const out = join(base, 'outside.txt');
writeFileSync(out, 'outside');
const sibling = join(base, 'W-evil');
mkdirSync(sibling, { recursive: true });
writeFileSync(join(sibling, 'f.txt'), 'sibling');

const { BashProgram } = await jiti(`${PKG}/access-intent/bash/program.ts`);
const { PathNormalizer } = await jiti(`${PKG}/path/path-normalizer.ts`);
const { posixPathFlavor } = await jiti(`${PKG}/path/path-flavor.ts`);

const normalizer = new PathNormalizer(posixPathFlavor, W);
const prog = await BashProgram.parse('echo x > ../outside.txt', normalizer);
console.log('readsVerbatim:', prog.readsVerbatim());
console.log('externalAccesses:');
for (const a of prog.externalAccesses()) {
  console.log('  value:', a.value(), '| effect:', a.effect?.effect ?? a.effect);
}
