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
: "${GCC_VERSION:?Set GCC_VERSION from the captured execution image}"

test -d "$LLVM_SRC/llvm"
test -d "$SYSROOT_DIR"

if [[ -f "$package_root/build/work/native-tools.env" ]]; then
  # shellcheck disable=SC1091
  source "$package_root/build/work/native-tools.env"
else
  "$package_root/build/build-native-tools.sh"
  # shellcheck disable=SC1091
  source "$package_root/build/work/native-tools.env"
fi

: "${SYSTEM_INDEX_BUILDER:?native tool build did not provide SystemIndexBuilder}"
test -x "$SYSTEM_INDEX_BUILDER"

mkdir -p "$package_root/assets"
builder_args=(
  --target="$TARGET_TRIPLE" \
  --sysroot="$SYSROOT_DIR" \
  --gcc-version="$GCC_VERSION" \
  --output="$package_root/assets/system.index" \
  --public-header-allowlist="$package_root/build/public-headers.txt"
)

toolchain_file="$(dirname "$SYSROOT_DIR")/toolchain.txt"
test -f "$toolchain_file" || {
  echo "Captured sysroot is missing toolchain.txt." >&2
  exit 1
}
while IFS= read -r include_dir; do
  builder_args+=(--include-dir="$include_dir")
done < <(awk '/^includeDirectories=/{capture=1; next} /^compilerVersionOutput=/{capture=0} capture' "$toolchain_file")

if [[ -n "${CLANG_RESOURCE_DIR:-}" ]]; then
  builder_args+=(--resource-dir="$CLANG_RESOURCE_DIR")
fi

"$SYSTEM_INDEX_BUILDER" "${builder_args[@]}"
test -s "$package_root/assets/system.index"
node "$package_root/build/write-manifest.mjs"

echo "System index and manifest written to assets/."
