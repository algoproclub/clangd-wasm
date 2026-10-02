# `@algoproclub/clangd-wasm`

This package publishes a finished browser clangd runtime: Emscripten glue and
WASM, a preloaded AArch64 GNU C++ sysroot, and a prebuilt system-only clangd
index. Application developers install the package from the public npm registry;
local release builds use LLVM, Emscripten and the execution-image sysroot.

The package contains the SharedWorker and its document-session broker. Consumers
only open a session; they never copy artifacts into a public directory or know
their filenames.

## Consumer integration

Install a released version from npm:

```sh
yarn add @algoproclub/clangd-wasm
```

The browser-facing entry point opens one session on the package worker:

```ts
import { openClangdSession } from "@algoproclub/clangd-wasm";

const session = await openClangdSession({
  uri: "file:///lsp/example/main.cpp",
  compilerArguments: `-std=c++23 -DNAME="Ada Lovelace" -Wall`,
});
```

`session.port` is a JSON-RPC `MessagePort`; `session.dispose()` only detaches
that document. The package resolves generated WASM/data/index URLs through its
bundler-aware worker modules. The runtime requires `SharedWorker` and WebAssembly
JSPI; `openClangdSession()` rejects before starting a worker when either is
unavailable. Applications can check the same requirement without loading the
worker or its assets:

```ts
import { isClangdWasmSupported } from "@algoproclub/clangd-wasm/support";
```

The helper validates the JSPI API plus a tiny Wasm module containing
`memory.copy` and `return_call`. Its readable source is
`build/required-wasm-features.wat`; maintainers regenerate the checked-in byte
array with `npm run generate:support-probe` (requires WABT's `wat2wasm`).

Each session may append workspace compiler arguments to the package's default
target, sysroot, include paths, and C++20 mode. This supports language-standard,
warning, macro, and include settings while clangd still disables compiler
operations that are unsuitable for language-server parsing.
`compilerArguments` accepts either a shell-like string or an already-tokenized
string array. String parsing handles quotes and backslash escapes without shell
expansion.

## Release inputs

`build/config.env` pins LLVM 23.1.1, Emscripten 6.0.9, AArch64 Linux and
ThinLTO. The WASM build enables JSPI and tail calls. The local release process
captures the exact GCC/libstdc++/glibc header tree and include-search order from
the execution image.

Use the same canonical `/sysroot` paths during native index generation and in
the browser. Capture internal headers needed for parsing, but use
`build/public-headers.txt` to limit completion suggestions to public header
spellings.

The native upstream `clangd-indexer` indexes one generated translation unit
containing the public-header allowlist and emits `system.index`. Its compile
database uses a VFS overlay so declaration paths are recorded under the same
`/sysroot` mount used in the browser. It never indexes student documents.

## Local release process

1. On the production execution host, run `npm run capture:sysroot -- <out>`.
   Keep the emitted archive, SHA-256, and GCC version.
2. On the release machine, run `npm run acquire:dependencies`, set
   `SYSROOT_ARCHIVE_URL`, `SYSROOT_ARCHIVE_SHA256`, and `GCC_VERSION`, then run
   `npm run fetch:sysroot`.
3. Run `npm run build:artifacts`. It builds the WASM engine, the native index
   helper, `system.index`, and the compiler include-path configuration.
4. Run `npm run pack:check`, then `npm pack`. Install that tarball in the IDE
   and run browser checks before publishing the same tarball.

The engine owns clangd's transport, mounts `headers.data`, loads
`system.index`, and runs synchronously: `AsyncThreadsCount=0`, no
dynamic/background student index, `ForceLoadPreamble`, IWYU include insertion,
and decision-forest ranking. Its growable WebAssembly heap starts at 128 MiB;
the worker logs each observed growth so browser memory pressure is visible.

LLVM thread support stays on because clangd's CMake target requires it. The
browser build itself uses no Emscripten pthreads. The build applies the small
upstream-oriented patch in
`patches/clangd-disable-speculative-completion-without-workers.patch`, which
prevents speculative completion from creating a thread when
`AsyncThreadsCount` is zero.

## Publishing

The package is published publicly to npmjs.com under the `@algoproclub`
organization. Build and validate the tarball locally, log in with an account
that can publish to the organization, then publish that exact file:

```sh
npm login
npm publish ./algoproclub-clangd-wasm-<version>.tgz
```

No CI workflow builds, validates or publishes this package yet.
