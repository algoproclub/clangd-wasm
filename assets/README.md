# Generated release assets

Local release builds write `clangd-runtime.mjs`, `clangd.wasm`, `headers.data`, `system.index`, and
`clangd-compile-config.json`.

They are deliberately not committed. Consumers install the finished npm package;
they never need an LLVM checkout, Emscripten, or the captured AArch64 sysroot.
