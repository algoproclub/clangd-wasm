#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$package_root/build/config.env"
if [[ -f "$package_root/build/work/dependencies.env" ]]; then
  # shellcheck disable=SC1091
  source "$package_root/build/work/dependencies.env"
fi

: "${LLVM_SRC:?Run npm run acquire:dependencies or set LLVM_SRC}"
test -d "$LLVM_SRC/llvm"
test -f "$package_root/native/CMakeLists.txt" || {
  echo "Missing native/CMakeLists.txt (the clangd bridge and SystemIndexBuilder source)." >&2
  exit 1
}

build_dir="$package_root/build/work/llvm-host"
# The index builder is a short-lived local release tool. Avoid the large
# link-time optimization cost here; ThinLTO belongs only to the browser
# runtime build in build-engine.sh.
cmake -S "$LLVM_SRC/llvm" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_ENABLE_PROJECTS='clang;clang-tools-extra' \
  -DLLVM_EXTERNAL_PROJECTS=clangd_wasm \
  -DLLVM_EXTERNAL_CLANGD_WASM_SOURCE_DIR="$package_root/native" \
  -DLLVM_TARGETS_TO_BUILD=Native \
  -DLLVM_ENABLE_LTO=OFF \
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

cmake --build "$build_dir" --target llvm-tblgen clang-tblgen "$HOST_INDEX_TARGET"
builder="$build_dir/bin/SystemIndexBuilder"
test -x "$builder" || {
  echo "Native target built but was not found at $builder." >&2
  exit 1
}

mkdir -p "$package_root/build/work"
printf 'export SYSTEM_INDEX_BUILDER=%q\n' "$builder" > "$package_root/build/work/native-tools.env"
echo "Native SystemIndexBuilder is ready at $builder"
