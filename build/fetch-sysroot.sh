#!/usr/bin/env bash
set -euo pipefail

package_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
: "${SYSROOT_ARCHIVE_URL:?Set the private archive URL in SYSROOT_ARCHIVE_URL}"
: "${SYSROOT_ARCHIVE_SHA256:?Set the expected SHA-256 in SYSROOT_ARCHIVE_SHA256}"

if ! [[ "$SYSROOT_ARCHIVE_SHA256" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "SYSROOT_ARCHIVE_SHA256 must be a 64-character SHA-256 digest." >&2
  exit 1
fi

download_dir="$package_root/build/work/sysroot-download"
archive="$download_dir/sysroot.tar.zst"
mkdir -p "$download_dir" "$package_root/build/work"

if [[ "$SYSROOT_ARCHIVE_URL" == file://* ]]; then
  # A release engineer may keep the captured archive on the build machine.
  # Keep this explicit rather than weakening the HTTPS policy for remote input.
  cp "${SYSROOT_ARCHIVE_URL#file://}" "$archive"
else
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    --output "$archive" "$SYSROOT_ARCHIVE_URL"
fi
actual_sha256=$(shasum -a 256 "$archive" | awk '{print $1}')
if [[ "$actual_sha256" != "$SYSROOT_ARCHIVE_SHA256" ]]; then
  echo "Sysroot archive SHA-256 mismatch." >&2
  echo "Expected: $SYSROOT_ARCHIVE_SHA256" >&2
  echo "Actual:   $actual_sha256" >&2
  exit 1
fi

# Never replace a caller-provided directory. Every invocation receives a new,
# private extraction directory beneath ignored build/work/.
destination=$(mktemp -d "$package_root/build/work/sysroot.XXXXXX")
tar --use-compress-program=unzstd --extract --file "$archive" --directory "$destination" \
  --no-same-owner --no-same-permissions

sysroot="$destination/sysroot"
test -d "$sysroot/usr/include" || {
  echo "The sysroot archive does not contain sysroot/usr/include/." >&2
  exit 1
}
printf 'export SYSROOT_DIR=%q\n' "$sysroot" > "$package_root/build/work/sysroot.env"
echo "Verified sysroot extracted to $sysroot"
