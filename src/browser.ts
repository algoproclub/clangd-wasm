import { normalizeCompilerArguments } from "./compiler-arguments.js";
import { isClangdWasmSupported } from "./support.js";

export interface OpenClangdSessionOptions {
  compilerArguments?: string | readonly string[];
  signal?: AbortSignal;
  uri: string;
}

export interface ClangdSession {
  /** Settles if the shared native clangd runtime terminates unexpectedly. */
  closed: Promise<Error>;
  dispose(): void;
  port: MessagePort;
}

interface ReadyMessage {
  type: "algopro/clangd-ready";
}

interface ErrorMessage {
  message: string;
  type: "algopro/clangd-error";
}

interface ClosedMessage {
  message: string;
  type: "algopro/clangd-closed";
}

const assets = {
  compileConfigUrl: new URL(
    "../assets/clangd-compile-config.json",
    import.meta.url,
  ).href,
  dataUrl: new URL("../assets/headers.data", import.meta.url).href,
  indexUrl: new URL("../assets/system.index", import.meta.url).href,
  runtimeUrl: new URL("../assets/clangd-runtime.mjs", import.meta.url).href,
  wasmUrl: new URL("../assets/clangd.wasm", import.meta.url).href,
};
const workerUrl = new URL("./clangd.shared-worker.js", import.meta.url);
workerUrl.searchParams.set(
  "assets",
  [
    assets.compileConfigUrl,
    assets.dataUrl,
    assets.indexUrl,
    assets.runtimeUrl,
    assets.wasmUrl,
  ].join("|"),
);

/** Opens one document session on the package's singleton clangd SharedWorker. */
export async function openClangdSession(
  options: OpenClangdSessionOptions,
): Promise<ClangdSession> {
  if (!isClangdWasmSupported()) {
    throw new Error("Local C++ language services are not supported here");
  }
  const worker = new SharedWorker(workerUrl, {
    name: "algopro-clangd",
    type: "module",
  });
  const port = worker.port;
  port.start();

  let closeSession!: (error: Error) => void;
  const closed = new Promise<Error>((resolve) => {
    closeSession = resolve;
  });
  const onControlMessage = (event: MessageEvent<unknown>) => {
    if (!isClosed(event.data)) return;
    event.stopImmediatePropagation();
    closeSession(new Error(event.data.message));
    port.close();
  };
  const workerFailed = (event: ErrorEvent) => {
    closeSession(new Error(event.message || "clangd worker failed"));
    port.close();
  };
  const messageFailed = () => {
    closeSession(new Error("Could not read a clangd worker message"));
    port.close();
  };
  worker.addEventListener("error", workerFailed);
  port.addEventListener("message", onControlMessage);
  port.addEventListener("messageerror", messageFailed);

  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () =>
        finish(() => reject(new DOMException("Aborted", "AbortError")));
      const onMessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (isReady(message)) finish(resolve);
        if (isError(message)) finish(() => reject(new Error(message.message)));
      };
      const cleanup = () => {
        options.signal?.removeEventListener("abort", abort);
        port.removeEventListener("message", onMessage);
      };
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };

      if (options.signal?.aborted) return abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      port.addEventListener("message", onMessage);
      void closed.then((error) => finish(() => reject(error)));
      port.postMessage({
        type: "algopro/clangd-attach",
        assets,
        compilerArguments: normalizeCompilerArguments(
          options.compilerArguments,
        ),
        uri: options.uri,
      });
    });
  } catch (error) {
    worker.removeEventListener("error", workerFailed);
    port.removeEventListener("message", onControlMessage);
    port.removeEventListener("messageerror", messageFailed);
    port.postMessage({ type: "algopro/clangd-detach" });
    port.close();
    throw error;
  }

  let disposed = false;
  return {
    closed,
    port,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      worker.removeEventListener("error", workerFailed);
      port.removeEventListener("message", onControlMessage);
      port.removeEventListener("messageerror", messageFailed);
      port.postMessage({ type: "algopro/clangd-detach" });
      port.close();
    },
  };
}

function isClosed(value: unknown): value is ClosedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "algopro/clangd-closed" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function isReady(value: unknown): value is ReadyMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "algopro/clangd-ready"
  );
}

function isError(value: unknown): value is ErrorMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "algopro/clangd-error" &&
    "message" in value &&
    typeof value.message === "string"
  );
}
