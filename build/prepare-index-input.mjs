import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const workDir = resolve(packageRoot, "build/work/system-index-input");
const sysroot = requiredEnvironment("SYSROOT_DIR");
const target = requiredEnvironment("TARGET_TRIPLE");
const resourceDir = requiredEnvironment("CLANG_RESOURCE_DIR");
const resourceVersion = resourceDir.split("/").at(-1);
if (!resourceVersion || !/^\d+$/u.test(resourceVersion)) {
  throw new Error(`Cannot derive Clang resource version from ${resourceDir}`);
}
const toolchainFile = resolve(sysroot, "../toolchain.txt");

const toolchain = await readFile(toolchainFile, "utf8");
const includeDirectories = section(toolchain, "includeDirectories");
if (includeDirectories.length === 0) {
  throw new Error(`${toolchainFile} contains no captured include directories`);
}
for (const directory of includeDirectories) {
  if (!directory.startsWith("/usr/") || directory.includes("..")) {
    throw new Error(`Unsafe captured include directory: ${directory}`);
  }
}

const headers = (await readFile(resolve(packageRoot, "build/public-headers.txt"), "utf8"))
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
for (const header of headers) {
  if (!/^[A-Za-z0-9_./+-]+$/u.test(header) || header.includes("..")) {
    throw new Error(`Unsafe public header: ${header}`);
  }
}

await mkdir(workDir, { recursive: true });
const source = resolve(workDir, "system-index.cpp");
const overlay = resolve(workDir, "vfs-overlay.yaml");
await writeFile(
  source,
  [
    "#if !__has_include(<vector>)",
    "#error Captured include directories cannot find <vector>",
    "#endif",
    ...headers.flatMap((header) => [
      `#if __has_include(<${header}>)`,
      `#include <${header}>`,
      "#endif",
    ]),
    "",
  ].join("\n"),
);
await writeFile(
  overlay,
  JSON.stringify(
    {
      version: 0,
      "use-external-names": false,
      roots: [
        await mapDirectory("/sysroot", sysroot),
        await mapDirectory(`/lib/clang/${resourceVersion}`, resourceDir),
      ],
    },
    null,
    2,
  ),
);

const arguments_ = [
  "clang++",
  `--target=${target}`,
  "--sysroot=/sysroot",
  "-nostdinc++",
  "-std=c++23",
  "-xc++",
  "-fsyntax-only",
  `-resource-dir=/lib/clang/${resourceVersion}`,
  ...includeDirectories.flatMap((directory) => [
    "-isystem",
    `/sysroot${directory}`,
  ]),
  source,
];
await writeFile(
  resolve(workDir, "compile_commands.json"),
  JSON.stringify([{ directory: workDir, file: source, arguments: arguments_ }], null, 2),
);

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function mapDirectory(virtualName, externalDirectory) {
  const entries = await readdir(externalDirectory, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return {
    type: "directory",
    name: virtualName,
    contents: await Promise.all(
      entries.map((entry) => {
        const externalPath = join(externalDirectory, entry.name);
        if (entry.isDirectory()) return mapDirectory(entry.name, externalPath);
        if (!entry.isFile()) {
          throw new Error(`Unsupported filesystem entry in sysroot: ${externalPath}`);
        }
        return {
          type: "file",
          name: entry.name,
          "external-contents": externalPath,
        };
      }),
    ),
  };
}

function section(contents, name) {
  const lines = contents.split(/\r?\n/u);
  const start = lines.indexOf(`${name}=`);
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^[A-Za-z]+=/u.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter(Boolean);
}
