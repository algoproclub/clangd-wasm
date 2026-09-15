#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$package_root/build/config.env"

: "${SYSTEM_INDEX_BUILDER:?Set SYSTEM_INDEX_BUILDER to the native helper built from the pinned LLVM source}"
: "${SYSROOT_DIR:?Set SYSROOT_DIR to the captured production AArch64 sysroot}"
: "${GCC_VERSION:?Set GCC_VERSION from the captured execution image}"

mkdir -p "$package_root/assets"
"$SYSTEM_INDEX_BUILDER" \
  --target="$TARGET_TRIPLE" \
  --sysroot="$SYSROOT_DIR" \
  --output="$package_root/assets/system.index" \
  --public-header-allowlist="$package_root/build/public-headers.txt"

echo "System index written. Run npm run verify:assets after staging the remaining generated artifacts."
