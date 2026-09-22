import { REQUIRED_WASM_FEATURES } from "./required-wasm-features.js";

/** Checks the browser APIs and Wasm features required by the packaged runtime. */
export function isClangdWasmSupported(): boolean {
  if (typeof SharedWorker !== "function" || typeof WebAssembly === "undefined") {
    return false;
  }
  const wasm = WebAssembly as typeof WebAssembly & {
    Suspending?: unknown;
    promising?: unknown;
  };
  return (
    typeof wasm.Suspending === "function" &&
    typeof wasm.promising === "function" &&
    WebAssembly.validate(REQUIRED_WASM_FEATURES)
  );
}
