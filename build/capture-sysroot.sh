#!/usr/bin/env bash
set -euo pipefail

# Run this on the production execution host. It archives every compiler search
# directory under /usr, preserving its absolute path beneath sysroot/. The WASM
# runtime mounts that directory at /sysroot.

cxx=${CXX:-g++}
output=${1:-aarch64-gcc-sysroot.tar.zst}

command -v "$cxx" >/dev/null
command -v zstd >/dev/null

triple=$("$cxx" -dumpmachine)
gcc_version=$("$cxx" -dumpfullversion -dumpversion)
if [[ "$triple" != aarch64-linux-gnu ]]; then
  echo "Expected aarch64-linux-gnu, got $triple" >&2
  exit 2
fi

mapfile -t include_dirs < <(
  "$cxx" -E -x c++ - -v </dev/null 2>&1 |
    sed -n '/#include <...> search starts here:/,/End of search list./p' |
    sed '1d;$d;s/^[[:space:]]*//' |
    sed 's/ (framework directory)$//'
)

if ((${#include_dirs[@]} == 0)); then
  echo "Could not discover C++ include directories" >&2
  exit 1
fi

stage=$(mktemp -d)
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
mkdir -p "$stage/sysroot"

for dir in "${include_dirs[@]}"; do
  dir=$(realpath -e "$dir")
  case "$dir" in
    /usr/*) ;;
    *)
      echo "Refusing to capture non-system include directory: $dir" >&2
      exit 2
      ;;
  esac

  mkdir -p "$stage/sysroot$(dirname "$dir")"
  cp -aL "$dir" "$stage/sysroot$dir"
done

{
  printf 'targetTriple=%s\n' "$triple"
  printf 'gccVersion=%s\n' "$gcc_version"
  printf 'compiler=%s\n' "$(command -v "$cxx")"
  printf 'includeDirectories=\n'
  printf '%s\n' "${include_dirs[@]}"
  printf 'compilerVersionOutput=\n'
  "$cxx" --version
} >"$stage/toolchain.txt"

tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -C "$stage" -I 'zstd -19 -T0' -cf "$output" sysroot toolchain.txt

sha256sum "$output"
echo "Captured $triple GCC $gcc_version in $output"
