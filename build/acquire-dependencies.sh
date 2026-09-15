#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$package_root/build/config.env"

dependencies_dir=${BUILD_DEPENDENCIES_DIR:-"$package_root/build/deps"}
llvm_source=${LLVM_SRC:-"$dependencies_dir/llvm-project"}
emsdk_root=${EMSDK:-"$dependencies_dir/emsdk"}

require_command() {
  command -v "$1" >/dev/null || {
    echo "Required command is unavailable: $1" >&2
    exit 1
  }
}

require_command git
require_command cmake
require_command ninja
require_command python3

checkout_revision() {
  local directory=$1 repository=$2 revision=$3
  if [[ ! -d "$directory/.git" ]]; then
    git clone --filter=blob:none --no-checkout "$repository" "$directory"
  fi

  git -C "$directory" fetch --depth=1 origin "refs/tags/$revision"
  git -C "$directory" checkout --detach FETCH_HEAD
  git -C "$directory" diff --quiet
  git -C "$directory" diff --cached --quiet
}

mkdir -p "$dependencies_dir" "$package_root/build/work"
checkout_revision "$llvm_source" "$LLVM_REPOSITORY" "$LLVM_REVISION"
checkout_revision "$emsdk_root" "$EMSDK_REPOSITORY" "$EMSDK_VERSION"

"$emsdk_root/emsdk" install "$EMSDK_VERSION"
"$emsdk_root/emsdk" activate "$EMSDK_VERSION"

llvm_commit=$(git -C "$llvm_source" rev-parse HEAD)
emsdk_commit=$(git -C "$emsdk_root" rev-parse HEAD)
printf 'export LLVM_SRC=%q\nexport EMSDK=%q\nexport LLVM_COMMIT=%q\nexport EMSDK_COMMIT=%q\n' \
  "$llvm_source" "$emsdk_root" "$llvm_commit" "$emsdk_commit" \
  > "$package_root/build/work/dependencies.env"

echo "LLVM $LLVM_REVISION ($llvm_commit) and Emscripten $EMSDK_VERSION ($emsdk_commit) are ready."
