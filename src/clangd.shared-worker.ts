/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  Message,
  type NotificationMessage,
  type RequestMessage,
  type ResponseMessage,
} from "vscode-jsonrpc/lib/common/messages.js";

interface RuntimeAssets {
  compileConfigUrl: string;
  dataUrl: string;
  indexUrl: string;
  runtimeUrl: string;
  wasmUrl: string;
}

interface EmscriptenModule {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
  };
  HEAPU8: Uint8Array;
  ccall(
    name: string,
    returnType: string | null,
    types: string[],
    values: unknown[],
    options?: { async?: boolean },
  ): unknown;
}

interface ClangdRuntime {
  compilerCommandPrefix: string[];
  send(message: JsonRpcMessage): void;
  stop(): Promise<void>;
}

interface RuntimeCallbacks {
  onError(error: Error): void;
  onMessage(message: JsonRpcMessage): void;
}

interface AttachMessage {
  assets: RuntimeAssets;
  compilerArguments: string[];
  type: "algopro/clangd-attach";
  uri: string;
}

interface Session {
  compilerArguments: string[];
  externalUri: string;
  internalPath: string;
  internalUri: string;
  port: MessagePort;
}

interface RequestOwner {
  id: JsonRpcId;
  method: string;
  session: Session;
}

type JsonRpcId = number | string | null;
type JsonRpcMessage =
  | NotificationMessage
  | RequestMessage
  | ResponseMessage;

const BACKEND_INITIALIZE_ID = "algopro/clangd-initialize";
const FORWARDED_SERVER_CAPABILITIES = [
  "completionProvider",
  "definitionProvider",
  "documentFormattingProvider",
  "hoverProvider",
  "positionEncoding",
  "referencesProvider",
  "renameProvider",
  "semanticTokensProvider",
  "signatureHelpProvider",
  "textDocumentSync",
] as const;

/** One native clangd runtime, multiplexed over all connected MessagePorts. */
class ClangdBroker {
  private assets: RuntimeAssets | null = null;
  private backendReady: Promise<void> | null = null;
  private backendFailure: Error | null = null;
  private backendInitializeResult: {
    capabilities?: Record<string, any>;
  } | null = null;
  private readonly requestOwners = new Map<JsonRpcId, RequestOwner>();
  private runtime: ClangdRuntime | null = null;
  private readonly sessions = new Set<Session>();
  private nextRequestId = 0;
  private nextSessionId = 0;
  private stopRequested = false;

  attach(port: MessagePort, message: AttachMessage) {
    this.assets ??= message.assets;
    const sessionId = ++this.nextSessionId;
    const internalPath = `/sessions/${sessionId}/main.cpp`;
    const session: Session = {
      port,
      compilerArguments: message.compilerArguments,
      externalUri: message.uri,
      internalPath,
      internalUri: `file://${internalPath}`,
    };
    this.sessions.add(session);
    port.onmessage = (event) => this.handlePortMessage(session, event.data);
    port.start();

    void this.ensureBackend()
      .then(() => {
        if (!this.sessions.has(session)) {
          return;
        }

        port.postMessage({ type: "algopro/clangd-ready" });
      })
      .catch((error) => {
        if (!this.sessions.has(session)) return;
        this.detach(session);
        port.postMessage({
          type: "algopro/clangd-error",
          message:
            error instanceof Error ? error.message : "Failed to start clangd",
        });
      });
  }

  private async ensureBackend() {
    if (this.backendFailure) {
      throw this.backendFailure;
    }
    if (!this.backendReady) {
      this.stopRequested = false;
      this.backendReady = this.startBackend();
    }

    return this.backendReady;
  }

  private async startBackend() {
    let runtime: ClangdRuntime | null = null;
    try {
      const createdRuntime = await createClangdRuntime(this.assets!, {
        onMessage: (message) => this.handleBackendMessage(message),
        onError: (error) => this.failBackend(error),
      });
      runtime = createdRuntime;
      if (this.stopRequested || this.sessions.size === 0) {
        await createdRuntime.stop();
        throw new Error("Local C++ language service was closed while starting");
      }
      this.runtime = createdRuntime;

      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => {
          this.backendInitializationDone = null;
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        this.backendInitializationDone = done;
        createdRuntime.send({
          jsonrpc: "2.0",
          id: BACKEND_INITIALIZE_ID,
          method: "initialize",
          params: {
            processId: null,
            rootUri: null,
            capabilities: {
              general: { positionEncodings: ["utf-16"] },
              textDocument: {
                completion: {
                  completionItem: { snippetSupport: true },
                },
                hover: { contentFormat: ["markdown", "plaintext"] },
                publishDiagnostics: {
                  relatedInformation: true,
                  versionSupport: true,
                },
                semanticTokens: {
                  formats: ["relative"],
                  multilineTokenSupport: false,
                  overlappingTokenSupport: false,
                  requests: { full: { delta: true }, range: true },
                  tokenModifiers: [
                    "declaration",
                    "definition",
                    "readonly",
                    "static",
                    "deprecated",
                    "abstract",
                    "async",
                    "modification",
                    "documentation",
                    "defaultLibrary",
                  ],
                  tokenTypes: [
                    "namespace",
                    "type",
                    "class",
                    "enum",
                    "interface",
                    "struct",
                    "typeParameter",
                    "parameter",
                    "variable",
                    "property",
                    "enumMember",
                    "event",
                    "function",
                    "method",
                    "macro",
                    "keyword",
                    "modifier",
                    "comment",
                    "string",
                    "number",
                    "regexp",
                    "operator",
                    "decorator",
                  ],
                },
                signatureHelp: {
                  contextSupport: true,
                  signatureInformation: {
                    activeParameterSupport: true,
                    documentationFormat: ["markdown", "plaintext"],
                    parameterInformation: { labelOffsetSupport: true },
                  },
                },
              },
            },
          },
        });
      });
      createdRuntime.send({
        jsonrpc: "2.0",
        method: "initialized",
        params: {},
      });
    } catch (error) {
      if (this.runtime === runtime) this.runtime = null;
      this.backendReady = null;
      await runtime?.stop().catch(() => undefined);
      throw error;
    }
  }

  private backendInitializationDone: ((error?: Error) => void) | null = null;

  private handlePortMessage(session: Session, message: unknown) {
    if (!isJsonRpcMessage(message)) {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "algopro/clangd-detach"
      ) {
        this.detach(session);
      }
      return;
    }

    if (!this.runtime) {
      if (Message.isRequest(message)) {
        session.port.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message:
              this.backendFailure?.message ??
              "Local C++ language service is not running",
          },
        });
      }
      return;
    }

    if (Message.isRequest(message) && message.method === "initialize") {
      this.replyVirtualInitialize(session, message);
      return;
    }
    if (
      (Message.isNotification(message) && message.method === "initialized") ||
      (Message.isRequest(message) && message.method === "shutdown")
    ) {
      if (Message.isRequest(message)) {
        session.port.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: null,
        });
      }
      return;
    }
    if (Message.isNotification(message) && message.method === "exit") {
      this.detach(session);
      return;
    }

    if (
      Message.isNotification(message) &&
      message.method === "$/cancelRequest"
    ) {
      this.forwardCancellation(session, message);
      return;
    }
    if (
      Message.isNotification(message) &&
      message.method === "textDocument/didOpen"
    ) {
      this.setCompileCommand(session);
    }

    const forwarded = translateUri(
      message,
      session.externalUri,
      session.internalUri,
    );
    if (Message.isRequest(message)) {
      const backendId = `algopro/${++this.nextRequestId}`;
      this.requestOwners.set(backendId, {
        id: message.id,
        method: message.method,
        session,
      });
      forwarded.id = backendId;
    }
    this.runtime.send(forwarded);
  }

  private forwardCancellation(
    session: Session,
    message: NotificationMessage,
  ) {
    const clientID = (message.params as { id?: unknown } | undefined)?.id;
    if (typeof clientID !== "number" && typeof clientID !== "string") return;
    const owner = [...this.requestOwners.entries()].find(
      ([, candidate]) =>
        candidate.session === session && candidate.id === clientID,
    );
    if (!owner) return;
    this.runtime?.send({
      ...message,
      params: { ...message.params, id: owner[0] },
    });
  }

  private replyVirtualInitialize(session: Session, message: RequestMessage) {
    const backendCapabilities =
      this.backendInitializeResult?.capabilities ?? {};
    const capabilities = Object.fromEntries(
      FORWARDED_SERVER_CAPABILITIES.flatMap((name) =>
        name in backendCapabilities ? [[name, backendCapabilities[name]]] : [],
      ),
    );
    session.port.postMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities,
        serverInfo: { name: "clangd-wasm" },
      },
    });
  }

  private setCompileCommand(session: Session) {
    if (!this.runtime) {
      return;
    }
    this.runtime.send({
      jsonrpc: "2.0",
      method: "workspace/didChangeConfiguration",
      params: {
        settings: {
          compilationDatabaseChanges: {
            [session.internalPath]: {
              workingDirectory: "/sessions",
              compilationCommand: [
                ...this.runtime.compilerCommandPrefix,
                "-std=c++20",
                ...session.compilerArguments,
                session.internalPath,
              ],
            },
          },
        },
      },
    });
  }

  private handleBackendMessage(message: JsonRpcMessage) {
    if (Message.isResponse(message) && message.id === BACKEND_INITIALIZE_ID) {
      if ("error" in message) {
        this.backendInitializationDone?.(
          new Error(message.error?.message ?? "clangd initialization failed"),
        );
      } else {
        this.backendInitializeResult =
          typeof message.result === "object" &&
          message.result !== null &&
          !Array.isArray(message.result)
            ? (message.result as { capabilities?: Record<string, any> })
            : null;
        this.backendInitializationDone?.();
      }
      return;
    }

    if (Message.isResponse(message)) {
      const owner = this.requestOwners.get(message.id);
      if (!owner) {
        return;
      }
      this.requestOwners.delete(message.id);
      if ("error" in message) {
        console.error(`[clangd-wasm] ${owner.method} failed`, message.error);
      }
      owner.session.port.postMessage({
        ...translateUri(
          message,
          owner.session.internalUri,
          owner.session.externalUri,
        ),
        id: owner.id,
      });
      return;
    }

    if (!Message.isNotification(message)) return;
    const uri = (message.params as { uri?: unknown } | undefined)?.uri;
    if (typeof uri === "string") {
      for (const session of this.sessions) {
        if (session.internalUri === uri) {
          session.port.postMessage(
            translateUri(message, session.internalUri, session.externalUri),
          );
        }
      }
      return;
    }

    // Server notifications without a document URI are not relevant to a
    // particular editor session and intentionally remain private to the broker.
  }

  private detach(session: Session) {
    if (!this.sessions.delete(session)) {
      return;
    }
    for (const [id, owner] of this.requestOwners) {
      if (owner.session === session) {
        this.requestOwners.delete(id);
      }
    }
    this.runtime?.send({
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri: session.internalUri } },
    });
    if (this.sessions.size === 0) {
      void this.stop();
    }
  }

  private async stop() {
    this.stopRequested = true;
    this.backendInitializationDone?.(
      new Error("Local C++ language service was closed while starting"),
    );
    const runtime = this.runtime;
    this.runtime = null;
    this.backendReady = null;
    this.backendFailure = null;
    this.backendInitializeResult = null;
    this.requestOwners.clear();
    if (runtime) {
      await runtime.stop();
    }
  }

  private failBackend(error: Error) {
    console.error("[clangd-wasm] runtime failed", error);
    this.backendFailure = error;
    this.runtime = null;
    this.backendInitializationDone?.(error);
    for (const owner of this.requestOwners.values()) {
      owner.session.port.postMessage({
        jsonrpc: "2.0",
        id: owner.id,
        error: { code: -32603, message: error.message },
      });
    }
    this.requestOwners.clear();
    for (const session of this.sessions) {
      session.port.postMessage({
        type: "algopro/clangd-closed",
        message: error.message,
      });
    }
    this.sessions.clear();
  }
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (typeof value !== "object" || value === null) return false;
  return (
    Message.isRequest(value as JsonRpcMessage) ||
    Message.isNotification(value as JsonRpcMessage) ||
    Message.isResponse(value as JsonRpcMessage)
  );
}

function translateUri(value: unknown, from: string, to: string): any {
  if (Array.isArray(value))
    return value.map((item) => translateUri(item, from, to));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key === from ? to : key,
      typeof item === "string" &&
      (key === "uri" || key.endsWith("Uri")) &&
      item === from
        ? to
        : translateUri(item, from, to),
    ]),
  );
}

function isAttachMessage(value: unknown): value is AttachMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "algopro/clangd-attach" &&
    "assets" in value &&
    isRuntimeAssets(value.assets) &&
    "uri" in value &&
    typeof value.uri === "string" &&
    "compilerArguments" in value &&
    Array.isArray(value.compilerArguments) &&
    value.compilerArguments.every((argument) => typeof argument === "string")
  );
}

function isRuntimeAssets(value: unknown): value is RuntimeAssets {
  if (typeof value !== "object" || value === null) return false;
  return [
    "compileConfigUrl",
    "dataUrl",
    "indexUrl",
    "runtimeUrl",
    "wasmUrl",
  ].every(
    (key) =>
      key in value &&
      typeof (value as Record<string, unknown>)[key] === "string",
  );
}

async function createClangdRuntime(
  assets: RuntimeAssets,
  options: RuntimeCallbacks,
): Promise<ClangdRuntime> {
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let stopped = false;
  let run: Promise<unknown> | null = null;
  let stopping: Promise<void> | null = null;

  Object.assign(globalThis, {
    __algoproClangdPostMessage(message: string) {
      options.onMessage(JSON.parse(message) as JsonRpcMessage);
    },
    __algoproClangdReceiveMessage() {
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise<string | null>((resolve) => {
        wake = () => resolve(pending.shift() ?? null);
      });
    },
    __algoproClangdWakeMessageLoop() {
      wake?.();
      wake = null;
    },
  });

  const generated = (await import(
    /* webpackIgnore: true */ assets.runtimeUrl
  )) as {
    default(options: {
      locateFile(file: string): string;
    }): Promise<EmscriptenModule>;
  };
  const module = await generated.default({
    locateFile(file) {
      if (file.endsWith(".wasm")) return assets.wasmUrl;
      if (file.endsWith(".data")) return assets.dataUrl;
      return new URL(file, assets.runtimeUrl).href;
    },
  });
  let heapBytes = module.HEAPU8.byteLength;
  const reportHeapGrowth = () => {
    const currentHeapBytes = module.HEAPU8.byteLength;
    if (currentHeapBytes <= heapBytes) return;
    console.info(
      `[clangd-wasm] WebAssembly heap grew from ${formatMiB(heapBytes)} to ${formatMiB(currentHeapBytes)}`,
    );
    heapBytes = currentHeapBytes;
  };
  const [indexResponse, compileConfigResponse] = await Promise.all([
    fetch(assets.indexUrl),
    fetch(assets.compileConfigUrl),
  ]);
  if (!indexResponse.ok) {
    throw new Error(
      `Could not load system index: HTTP ${indexResponse.status}`,
    );
  }
  if (!compileConfigResponse.ok) {
    throw new Error(
      `Could not load compiler configuration: HTTP ${compileConfigResponse.status}`,
    );
  }
  const compileConfig = parseCompileConfiguration(
    await compileConfigResponse.json(),
  );
  module.FS.mkdirTree("/assets");
  module.FS.mkdirTree("/sessions");
  module.FS.writeFile(
    "/assets/system.index",
    new Uint8Array(await indexResponse.arrayBuffer()),
  );

  const runResult = module.ccall("clangd_wasm_run", "number", [], [], {
    async: true,
  });
  run = Promise.resolve(runResult);
  void run.then(
    (exitCode) => {
      if (!stopped) {
        options.onError(
          new Error(
            `clangd terminated unexpectedly with exit code ${String(exitCode)}`,
          ),
        );
      }
    },
    (error) => {
      if (!stopped) {
        options.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  );
  return {
    compilerCommandPrefix: [
      "clang++",
      `--target=${compileConfig.targetTriple}`,
      "--sysroot=/sysroot",
      "-nostdinc++",
      ...compileConfig.includeDirectories.flatMap((directory) => [
        "-isystem",
        directory,
      ]),
    ],
    send(message) {
      pending.push(JSON.stringify(message));
      wake?.();
      wake = null;
      setTimeout(reportHeapGrowth, 0);
    },
    stop() {
      if (!stopping) {
        stopped = true;
        module.ccall("clangd_wasm_stop", null, [], []);
        wake?.();
        wake = null;
        stopping = Promise.resolve(run).then(
          () => undefined,
          () => undefined,
        );
      }
      return stopping;
    },
  };
}

function formatMiB(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function parseCompileConfiguration(value: unknown): {
  includeDirectories: string[];
  targetTriple: string;
} {
  if (typeof value !== "object" || value === null) {
    throw new Error("Compiler configuration has an invalid shape");
  }
  const config = value as {
    includeDirectories?: unknown;
    targetTriple?: unknown;
  };
  if (
    typeof config.targetTriple !== "string" ||
    !Array.isArray(config.includeDirectories) ||
    !config.includeDirectories.every(
      (directory) =>
        typeof directory === "string" && directory.startsWith("/sysroot/usr/"),
    )
  ) {
    throw new Error("Compiler configuration has an invalid shape");
  }
  return {
    targetTriple: config.targetTriple,
    includeDirectories: config.includeDirectories,
  };
}

const broker = new ClangdBroker();
interface SharedWorkerScopeLike {
  onconnect: ((event: MessageEvent) => void) | null;
}

const workerScope = self as unknown as SharedWorkerScopeLike;
workerScope.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  const onFirstMessage = (messageEvent: MessageEvent<unknown>) => {
    if (!isAttachMessage(messageEvent.data)) {
      port.postMessage({
        type: "algopro/clangd-error",
        message: "Expected clangd attach message",
      });
      return;
    }
    broker.attach(port, messageEvent.data);
  };
  port.addEventListener("message", onFirstMessage, { once: true });
  port.start();
};
