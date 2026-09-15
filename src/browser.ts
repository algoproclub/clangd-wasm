export interface OpenClangdSessionOptions {
  compilerOptions: string | null;
  signal?: AbortSignal;
  uri: string;
}

export interface ClangdSession {
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

const workerUrl = new URL("./clangd.shared-worker.js", import.meta.url);

/** Opens one document session on the package's singleton clangd SharedWorker. */
export async function openClangdSession(
  options: OpenClangdSessionOptions,
): Promise<ClangdSession> {
  if (typeof SharedWorker === "undefined") {
    throw new Error("Local C++ language services are not supported here");
  }

  const worker = new SharedWorker(workerUrl, {
    name: "algopro-clangd",
    type: "module",
  });
  const port = worker.port;
  port.start();

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
    port.postMessage({
      type: "algopro/clangd-attach",
      uri: options.uri,
      compilerOptions: options.compilerOptions,
    });
  });

  return {
    port,
    dispose: () => {
      port.postMessage({ type: "algopro/clangd-detach" });
      port.close();
    },
  };
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
