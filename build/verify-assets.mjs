import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const requiredFiles = [
  "lib/browser.js",
  "lib/browser.d.ts",
  "lib/clangd.shared-worker.js",
  "lib/support.js",
  "lib/support.d.ts",
  "lib/required-wasm-features.js",
  "lib/required-wasm-features.d.ts",
  "assets/clangd-runtime.mjs",
  "assets/clangd.wasm",
  "assets/headers.data",
  "assets/system.index",
  "assets/clangd-compile-config.json",
];

for (const relativePath of requiredFiles) {
  const info = await stat(resolve(packageRoot, relativePath));
  if (!info.isFile() || info.size === 0) {
    throw new Error(`${relativePath} is missing or empty`);
  }
}

const wasm = await readFile(resolve(packageRoot, "assets/clangd.wasm"));
if (!wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
  throw new Error("assets/clangd.wasm does not have a WebAssembly header");
}

const runtime = await readFile(
  resolve(packageRoot, "assets/clangd-runtime.mjs"),
  "utf8",
);
if (!/\/lib\/clang\/\d+\/include\/stddef\.h/.test(runtime)) {
  throw new Error("clangd-runtime.mjs does not preload Clang resource headers");
}

const index = await readFile(resolve(packageRoot, "assets/system.index"));
if (!index.subarray(0, 4).equals(Buffer.from("RIFF"))) {
  throw new Error("assets/system.index is not a binary clangd index");
}
const stringTable = riffChunk(index, "stri");
if (stringTable.length < 4 || stringTable.readUInt32LE(0) !== 0) {
  throw new Error(
    "assets/system.index uses a compressed string table, but the browser runtime has zlib disabled",
  );
}

const config = JSON.parse(
  await readFile(
    resolve(packageRoot, "assets/clangd-compile-config.json"),
    "utf8",
  ),
);
if (
  typeof config.targetTriple !== "string" ||
  !Array.isArray(config.includeDirectories) ||
  config.includeDirectories.length === 0 ||
  !config.includeDirectories.every(
    (directory) =>
      typeof directory === "string" && directory.startsWith("/sysroot/"),
  )
) {
  throw new Error("clangd-compile-config.json has an invalid shape");
}

console.log("Package assets are present and internally recognizable.");

function riffChunk(contents, expectedId) {
  if (
    contents.length < 12 ||
    contents.subarray(8, 12).toString("ascii") !== "CdIx"
  ) {
    throw new Error("assets/system.index has an invalid clangd RIFF header");
  }
  for (let offset = 12; offset + 8 <= contents.length; ) {
    const id = contents.subarray(offset, offset + 4).toString("ascii");
    const size = contents.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > contents.length) {
      throw new Error("assets/system.index contains a truncated RIFF chunk");
    }
    if (id === expectedId) return contents.subarray(start, end);
    offset = end + (size & 1);
  }
  throw new Error(`assets/system.index is missing its ${expectedId} chunk`);
}
