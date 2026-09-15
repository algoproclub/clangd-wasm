import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const assetDirectory = resolve(packageRoot, 'assets');
const manifest = JSON.parse(
  await readFile(resolve(assetDirectory, 'manifest.json'), 'utf8')
);
const expected = [
  'clangd-runtime.mjs',
  'clangd.wasm',
  'headers.data',
  'system.index',
];

if (
  manifest.targetTriple !== 'aarch64-linux-gnu' ||
  manifest.thinLto !== true ||
  manifest.decisionForest !== true
) {
  throw new Error('Manifest must record AArch64, ThinLTO and decision forest.');
}

for (const name of expected) {
  const file = resolve(assetDirectory, name);
  const bytes = await readFile(file);
  const metadata = manifest.files?.[name];
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (
    !metadata ||
    metadata.bytes !== (await stat(file)).size ||
    metadata.sha256 !== digest
  ) {
    throw new Error(`Manifest does not match ${name}`);
  }
}

console.log('clangd-wasm assets verified');
