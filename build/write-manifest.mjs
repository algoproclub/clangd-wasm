import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const assets = resolve(packageRoot, 'assets');
const config = await readEnvironment(resolve(packageRoot, 'build/config.env'));
for (const name of ['SYSROOT_DIR', 'GCC_VERSION']) {
  if (!process.env[name]) throw new Error(`Set ${name} before writing the manifest.`);
}

const names = ['clangd-runtime.mjs', 'clangd.wasm', 'headers.data', 'system.index'];
const files = Object.fromEntries(await Promise.all(names.map(async name => {
  const path = resolve(assets, name);
  const content = await readFile(path);
  return [name, {
    bytes: (await stat(path)).size,
    sha256: createHash('sha256').update(content).digest('hex'),
  }];
})));

const manifest = {
  packageVersion: JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')).version,
  llvmRevision: config.LLVM_REVISION,
  emscriptenVersion: config.EMSDK_VERSION,
  targetTriple: config.TARGET_TRIPLE,
  gccVersion: process.env.GCC_VERSION,
  sysrootDigest: await directoryDigest(process.env.SYSROOT_DIR),
  indexDigest: files['system.index'].sha256,
  thinLto: true,
  decisionForest: true,
  files,
};
await writeFile(resolve(assets, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

async function directoryDigest(root) {
  const hash = createHash('sha256');
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hash.update(path.slice(root.length));
        hash.update(await readFile(path));
      }
    }
  };
  await visit(root);
  return hash.digest('hex');
}

async function readEnvironment(path) {
  const values = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^([A-Z_]+)=([^$#\s][^#]*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}
