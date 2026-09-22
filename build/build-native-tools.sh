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

: "${LLVM_SRC:?Run npm run acquire:dependencies or set LLVM_SRC}"
: "${EMSDK:?Run npm run acquire:dependencies or set EMSDK}"
test -d "$LLVM_SRC/llvm"
test -f "$EMSDK/emsdk_env.sh"
trap 'restore_llvm_patches "$LLVM_SRC"' EXIT INT TERM
apply_llvm_patches "$LLVM_SRC"
# CMake may regenerate the Emscripten build tree before dispatching the native
# sub-build, so its compiler probes still need the emsdk Python and config.
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null
build_dir="$package_root/build/work/llvm-wasm"
test -f "$build_dir/CMakeCache.txt" || {
  echo "The cross build is not configured. Run npm run build:engine first." >&2
  exit 1
}

cmake --build "$build_dir" --target clangd-wasm-native-indexer clang-resource-headers
cmake --build "$build_dir/NATIVE" --target clangd-indexer clang-resource-headers
indexer="$build_dir/NATIVE/bin/clangd-indexer"
test -x "$indexer" || {
  echo "Native clangd-indexer target was not found at $indexer." >&2
  exit 1
}

mkdir -p "$package_root/build/work"
llvm_version=${LLVM_REVISION#llvmorg-}
llvm_major=${llvm_version%%.*}
resource_dir="$build_dir/NATIVE/lib/clang/$llvm_major"
test -d "$resource_dir/include"
printf 'export CLANGD_INDEXER=%q\nexport CLANG_RESOURCE_DIR=%q\n' \
  "$indexer" "$resource_dir" > "$package_root/build/work/native-tools.env"
echo "Native clangd-indexer is ready at $indexer"
