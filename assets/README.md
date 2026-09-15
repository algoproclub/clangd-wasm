# Generated release assets

Release CI writes these files before publishing: `manifest.json`,
`clangd-runtime.mjs`, `clangd.wasm`, `headers.data`, and `system.index`.

They are deliberately not committed. Consumers install the finished npm package;
they never need an LLVM checkout, Emscripten, or the captured AArch64 sysroot.
