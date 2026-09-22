#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$package_root/build/config.env"
if [[ -f "$package_root/build/work/dependencies.env" ]]; then
  # shellcheck disable=SC1091
  source "$package_root/build/work/dependencies.env"
fi
if [[ -f "$package_root/build/work/sysroot.env" ]]; then
  # shellcheck disable=SC1091
  source "$package_root/build/work/sysroot.env"
fi

: "${LLVM_SRC:?Run npm run acquire:dependencies or set LLVM_SRC}"
: "${SYSROOT_DIR:?Set SYSROOT_DIR to the captured production AArch64 sysroot}"

test -d "$LLVM_SRC/llvm"
test -d "$SYSROOT_DIR"

if [[ -f "$package_root/build/work/native-tools.env" ]]; then
  # shellcheck disable=SC1091
  source "$package_root/build/work/native-tools.env"
fi
if [[ ! -x "${CLANGD_INDEXER:-}" ]]; then
  "$package_root/build/build-native-tools.sh"
  # shellcheck disable=SC1091
  source "$package_root/build/work/native-tools.env"
fi

: "${CLANGD_INDEXER:?native tool build did not provide clangd-indexer}"
: "${CLANG_RESOURCE_DIR:?native tool build did not provide Clang resource headers}"
test -x "$CLANGD_INDEXER"

mkdir -p "$package_root/assets"
TARGET_TRIPLE="$TARGET_TRIPLE" SYSROOT_DIR="$SYSROOT_DIR" \
  CLANG_RESOURCE_DIR="$CLANG_RESOURCE_DIR" \
  node "$package_root/build/prepare-index-input.mjs"
input_dir="$package_root/build/work/system-index-input"
index_tmp="$package_root/assets/system.index.tmp"
index_log="$package_root/build/work/system-index.log"
trap 'rm -f "$index_tmp"' EXIT
"$CLANGD_INDEXER" --executor=all-TUs \
  --vfsoverlay="$input_dir/vfs-overlay.yaml" \
  "$input_dir/compile_commands.json" \
  > "$index_tmp" 2> "$index_log"
cat "$index_log"
if grep -Eq ': (fatal )?error:' "$index_log"; then
  echo "clangd-indexer reported compiler errors." >&2
  exit 1
fi
test "$(wc -c < "$index_tmp")" -gt 1024
test "$(LC_ALL=C head -c 4 "$index_tmp")" = RIFF
mv "$index_tmp" "$package_root/assets/system.index"
trap - EXIT
TARGET_TRIPLE="$TARGET_TRIPLE" SYSROOT_DIR="$SYSROOT_DIR" \
  node "$package_root/build/write-compile-config.mjs"

echo "System index and compiler configuration written to assets/."
