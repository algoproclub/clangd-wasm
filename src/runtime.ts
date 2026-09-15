type JsonRpcMessage = Record<string, unknown>;

interface EmscriptenModule {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
  };
  ccall(name: string, returnType: string | null, types: string[], values: unknown[]): unknown;
}

interface RuntimeOptions {
  onError(error: Error): void;
  onMessage(message: JsonRpcMessage): void;
}

interface Runtime {
  send(message: JsonRpcMessage): void;
  stop(): Promise<void>;
}

/** Starts the generated Emscripten module after mounting the static index. */
export async function createClangdRuntime(options: RuntimeOptions): Promise<Runtime> {
  const wasmUrl = new URL('../assets/clangd.wasm', import.meta.url).href;
  const dataUrl = new URL('../assets/headers.data', import.meta.url).href;
  const indexUrl = new URL('../assets/system.index', import.meta.url).href;
  const runtimeUrl = new URL('../assets/clangd-runtime.mjs', import.meta.url).href;
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let stopped = false;

  Object.assign(globalThis, {
    __algoproClangdPostMessage(message: string) {
      options.onMessage(JSON.parse(message) as JsonRpcMessage);
    },
    __algoproClangdReceiveMessage() {
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise<string | null>(resolve => { wake = () => resolve(pending.shift() ?? null); });
    },
    __algoproClangdWakeMessageLoop() {
      wake?.();
      wake = null;
    },
  });

  const generated = await import(/* webpackIgnore: true */ runtimeUrl) as {
    default(options: { locateFile(file: string): string }): Promise<EmscriptenModule>;
  };
  const module = await generated.default({
    locateFile(file) {
      if (file.endsWith('.wasm')) return wasmUrl;
      if (file.endsWith('.data')) return dataUrl;
      return new URL(file, runtimeUrl).href;
    },
  });
  const indexResponse = await fetch(indexUrl);
  if (!indexResponse.ok) throw new Error(`Could not load system index: HTTP ${indexResponse.status}`);
  module.FS.mkdirTree('/assets');
  module.FS.writeFile('/assets/system.index', new Uint8Array(await indexResponse.arrayBuffer()));

  void Promise.resolve(module.ccall('clangd_wasm_run', 'number', [], [])).catch(error => {
    if (!stopped) options.onError(error instanceof Error ? error : new Error(String(error)));
  });
  return {
    send(message) {
      pending.push(JSON.stringify(message));
      wake?.();
      wake = null;
    },
    async stop() {
      stopped = true;
      module.ccall('clangd_wasm_stop', null, [], []);
      wake?.();
      wake = null;
    },
  };
}
