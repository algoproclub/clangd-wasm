#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$package_root/build/config.env"

: "${LLVM_SRC:?Set LLVM_SRC to a checkout at $LLVM_REVISION}"
: "${EMSDK:?Set EMSDK to the Emscripten SDK root at $EMSDK_VERSION}"
: "${SYSROOT_DIR:?Set SYSROOT_DIR to the captured production AArch64 sysroot}"

test -d "$LLVM_SRC/llvm"
test -d "$SYSROOT_DIR"
"$EMSDK/upstream/emscripten/emcmake" cmake -S "$LLVM_SRC/llvm" -B "$package_root/build/work/llvm-wasm" -G Ninja \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_ENABLE_PROJECTS=clang\;clang-tools-extra \
  -DLLVM_TARGETS_TO_BUILD= \
  -DLLVM_ENABLE_LTO="$LLVM_ENABLE_LTO" \
  -DLLVM_ENABLE_THREADS=ON \
  -DLLVM_ENABLE_ZLIB="$LLVM_ENABLE_ZLIB" \
  -DCLANGD_DECISION_FOREST="$CLANGD_DECISION_FOREST" \
  -DCLANG_ENABLE_CLANGD=ON \
  -DCLANG_BUILD_TOOLS=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCLANG_ENABLE_ARCMT=OFF \
  -DLLVM_BUILD_TESTS=OFF \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_DOCS=OFF

echo "Configuration complete. Build BrowserTransport/ClangdWasmMain after applying the submitted synchronous-completion patch."
