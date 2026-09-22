import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sysroot = process.env.SYSROOT_DIR;
const targetTriple = process.env.TARGET_TRIPLE;

if (!sysroot || !targetTriple) {
  throw new Error('Set SYSROOT_DIR and TARGET_TRIPLE before writing compiler configuration.');
}

const toolchainPath = resolve(dirname(sysroot), 'toolchain.txt');
const lines = (await readFile(toolchainPath, 'utf8')).split('\n');
const start = lines.indexOf('includeDirectories=');
const end = lines.indexOf('compilerVersionOutput=');
if (start === -1 || end === -1 || end <= start + 1) {
  throw new Error('Captured toolchain.txt has no include directory list.');
}

const includeDirectories = lines
  .slice(start + 1, end)
  .filter(Boolean)
  .map(directory => {
    if (!directory.startsWith('/usr/')) {
      throw new Error(`Captured include directory is not under /usr: ${directory}`);
    }
    return `/sysroot${directory}`;
  });

await writeFile(
  resolve(packageRoot, 'assets/clangd-compile-config.json'),
  `${JSON.stringify({ targetTriple, includeDirectories }, null, 2)}\n`
);
