#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$package_root/build/config.env"
# shellcheck disable=SC1091
source "$package_root/build/llvm-patches.sh"
if [[ -f "$package_root/build/work/dependencies.env" ]]; then
  # shellcheck disable=SC1091
  source "$package_root/build/work/dependencies.env"
fi
if [[ -f "$package_root/build/work/sysroot.env" ]]; then
  # shellcheck disable=SC1091
  source "$package_root/build/work/sysroot.env"
fi

: "${LLVM_SRC:?Run npm run acquire:dependencies or set LLVM_SRC}"
: "${EMSDK:?Run npm run acquire:dependencies or set EMSDK}"
: "${SYSROOT_DIR:?Set SYSROOT_DIR to the captured production AArch64 sysroot}"

test -d "$LLVM_SRC/llvm"
test -d "$SYSROOT_DIR"
test -x "$EMSDK/upstream/emscripten/emcmake"
mkdir -p "$package_root/build/work" "$package_root/assets"

trap 'restore_llvm_patches "$LLVM_SRC"' EXIT INT TERM
apply_llvm_patches "$LLVM_SRC"

# emsdk_env.sh establishes EM_CONFIG and cached compiler paths required by
# Emscripten even though CMake itself is launched through emcmake.
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null
"$EMSDK/upstream/emscripten/emcmake" cmake -S "$LLVM_SRC/llvm" -B "$package_root/build/work/llvm-wasm" -G Ninja \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_C_FLAGS=-mtail-call \
  -DCMAKE_CXX_FLAGS=-mtail-call \
  -DLLVM_ENABLE_PROJECTS=clang\;clang-tools-extra \
  -DLLVM_TARGETS_TO_BUILD= \
  -DLLVM_ENABLE_LTO="$LLVM_ENABLE_LTO" \
  -DCROSS_TOOLCHAIN_FLAGS_NATIVE=-DLLVM_ENABLE_ASSERTIONS=OFF\;-DLLVM_ENABLE_EH=OFF\;-DLLVM_ENABLE_RTTI=OFF\;-DLLVM_ENABLE_LTO=OFF\;-DLLVM_ENABLE_ZLIB=OFF\;-DCLANGD_TIDY_CHECKS=OFF\;-DCLANG_BUILD_TOOLS=OFF\;-DCLANG_ENABLE_STATIC_ANALYZER=OFF\;-DCLANG_ENABLE_ARCMT=OFF \
  -DLLVM_ENABLE_ASSERTIONS=OFF \
  -DLLVM_ENABLE_EH=OFF \
  -DLLVM_ENABLE_RTTI=OFF \
  -DLLVM_ENABLE_THREADS=ON \
  -DLLVM_ENABLE_ZLIB="$LLVM_ENABLE_ZLIB" \
  -DCLANGD_DECISION_FOREST="$CLANGD_DECISION_FOREST" \
  -DCLANGD_TIDY_CHECKS=OFF \
  -DCLANG_ENABLE_CLANGD=ON \
  -DLLVM_EXTERNAL_PROJECTS=clangd_wasm \
  -DLLVM_EXTERNAL_CLANGD_WASM_SOURCE_DIR="$package_root/native" \
  -DCLANGD_WASM_SYSROOT="$SYSROOT_DIR" \
  -DCLANG_BUILD_TOOLS=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCLANG_ENABLE_ARCMT=OFF \
  -DLLVM_BUILD_TESTS=OFF \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_DOCS=OFF
cmake --build "$package_root/build/work/llvm-wasm" \
  --target clangd-wasm-runtime clangd-wasm-native-indexer
cmake --build "$package_root/build/work/llvm-wasm/NATIVE" \
  --target clangd-indexer clang-resource-headers

runtime="$package_root/build/work/llvm-wasm/bin/clangd-runtime.js"
wasm="$package_root/build/work/llvm-wasm/bin/clangd-runtime.wasm"
headers="$package_root/build/work/llvm-wasm/bin/clangd-runtime.data"
test -s "$runtime"
test -s "$wasm"
test -s "$headers"
install -m 0644 "$runtime" "$package_root/assets/clangd-runtime.mjs"
install -m 0644 "$wasm" "$package_root/assets/clangd.wasm"
install -m 0644 "$headers" "$package_root/assets/headers.data"

native_indexer="$package_root/build/work/llvm-wasm/NATIVE/bin/clangd-indexer"
llvm_version=${LLVM_REVISION#llvmorg-}
llvm_major=${llvm_version%%.*}
resource_dir="$package_root/build/work/llvm-wasm/NATIVE/lib/clang/$llvm_major"
test -x "$native_indexer"
test -d "$resource_dir/include"
printf 'export CLANGD_INDEXER=%q\nexport CLANG_RESOURCE_DIR=%q\n' \
  "$native_indexer" "$resource_dir" > "$package_root/build/work/native-tools.env"

echo "WASM engine assets and native clangd-indexer are ready."
