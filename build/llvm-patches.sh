#!/usr/bin/env bash

llvm_patch_files() {
  printf '%s\n' \
    "$package_root/patches/clangd-disable-speculative-completion-without-workers.patch" \
    "$package_root/patches/clangd-indexer-vfs-overlay.patch"
}

llvm_patch_files_reverse() {
  printf '%s\n' \
    "$package_root/patches/clangd-indexer-vfs-overlay.patch" \
    "$package_root/patches/clangd-disable-speculative-completion-without-workers.patch"
}

apply_llvm_patches() {
  local llvm_source=$1 patch
  while IFS= read -r patch; do
    if git -C "$llvm_source" apply --reverse --check "$patch" >/dev/null 2>&1; then
      continue
    fi
    git -C "$llvm_source" apply --check "$patch"
    git -C "$llvm_source" apply "$patch"
  done < <(llvm_patch_files)
}

restore_llvm_patches() {
  local llvm_source=$1 patch
  while IFS= read -r patch; do
    if git -C "$llvm_source" apply --reverse --check "$patch" >/dev/null 2>&1; then
      git -C "$llvm_source" apply --reverse "$patch"
    fi
  done < <(llvm_patch_files_reverse)
}
