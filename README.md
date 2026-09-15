# `@algoproclub/clangd-wasm`

This package publishes a finished browser clangd runtime: Emscripten glue and
WASM, an LZ4-packed AArch64 GNU C++ sysroot, and a prebuilt system-only clangd
index. Application developers install the package from GitHub Packages; only release CI needs LLVM,
Emscripten and the execution-image sysroot.

The package contains the SharedWorker and its document-session broker. Consumers
only open a session; they never copy artifacts into a public directory or know
their filenames.

## Consumer integration

Configure the GitHub Packages scope once:

```ini
@algoproclub:registry=https://npm.pkg.github.com
```

Then install a released version:

```sh
yarn add @algoproclub/clangd-wasm@1.0.0
```

The browser-facing entry point opens one session on the package worker:

```ts
import { openClangdSession } from "@algoproclub/clangd-wasm";

const session = await openClangdSession({
  uri: "file:///lsp/example/main.cpp",
  compilerOptions: "-std=c++20",
});
```

`session.port` is a JSON-RPC `MessagePort`; `session.dispose()` only detaches
that document. The package resolves generated WASM/data/index URLs through its
bundler-aware worker modules.

## Release inputs

`build/config.env` pins LLVM 23.1.1, Emscripten 6.0.9, AArch64 Linux and
ThinLTO. The release job captures the exact GCC/libstdc++/glibc header tree and
include-search order from the execution image, then records GCC version and
source digest in `assets/manifest.json`.

Use the same canonical `/sysroot` paths during native index generation and in
the browser. Capture internal headers needed for parsing, but use
`build/public-headers.txt` to limit completion suggestions to public header
spellings.

The native `SystemIndexBuilder` uses clangd's upstream standard-library indexing
APIs and emits `system.index`. It must syntax-check its umbrella input, reject
diagnostics, and verify representative include edits before writing the
manifest. It must never index student documents.

## Build stages

1. Build native table-generation and system-index tools from the pinned LLVM source.
2. Capture the production AArch64 GNU sysroot and create `headers.data` with
   Emscripten LZ4 file packaging.
3. Run `npm run build:engine` to configure the WASM engine. Its C++ entry owns
   clangd's `Transport`, mounts `headers.data`, loads `system.index`, and uses
   synchronous clangd: `AsyncThreadsCount=0`, no dynamic/background student
   index, `ForceLoadPreamble`, IWYU include insertion and decision-forest ranking.
4. Build `system.index`, generate `assets/manifest.json`, then run
   `npm run pack:check`.
5. Install the generated tarball into a clean consumer and run browser checks
   before publishing that same tarball.

LLVM thread support stays on because clangd's CMake target requires it. The
browser build itself uses no Emscripten pthreads. Carry only the submitted
upstream fix that prevents speculative completion from creating a thread when
`AsyncThreadsCount` is zero.

## Required generated manifest

```json
{
  "packageVersion": "1.0.0",
  "llvmRevision": "llvmorg-23.1.1",
  "emscriptenVersion": "6.0.9",
  "targetTriple": "aarch64-linux-gnu",
  "gccVersion": "<captured version>",
  "sysrootDigest": "<sha256>",
  "indexDigest": "<sha256>",
  "thinLto": true,
  "decisionForest": true,
  "files": {
    "clangd-runtime.mjs": { "sha256": "<sha256>", "bytes": 1 },
    "clangd.wasm": { "sha256": "<sha256>", "bytes": 1 },
    "headers.data": { "sha256": "<sha256>", "bytes": 1 },
    "system.index": { "sha256": "<sha256>", "bytes": 1 }
  }
}
```

The manifest is artifact provenance and integrity data, not a runtime upgrade or
compatibility protocol. Students can reload if a deployment changes worker assets.

## Publishing

The GitHub Actions release workflow runs only for a complete artifact: it builds
the engine and index, validates the packed tarball in a clean consumer, and
publishes to GitHub Packages with `GITHUB_TOKEN` and `packages: write`.
