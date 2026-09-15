/* eslint-disable @typescript-eslint/no-explicit-any */

import { createClangdRuntime } from './runtime.js';

interface ClangdRuntime {
  send(message: JsonRpcMessage): void;
  stop(): Promise<void>;
}


interface AttachMessage {
  compilerOptions: string | null;
  type: 'algopro/clangd-attach';
  uri: string;
}

interface Session {
  compilerOptions: string | null;
  port: MessagePort;
  uri: string;
}

interface RequestOwner {
  id: JsonRpcId;
  session: Session;
}

type JsonRpcId = number | string;
type JsonRpcMessage = Record<string, any>;

const BACKEND_INITIALIZE_ID = 'algopro/clangd-initialize';

/** One native clangd runtime, multiplexed over all connected MessagePorts. */
class ClangdBroker {
  private backendReady: Promise<void> | null = null;
  private readonly requestOwners = new Map<JsonRpcId, RequestOwner>();
  private runtime: ClangdRuntime | null = null;
  private readonly sessions = new Set<Session>();
  private nextRequestId = 0;

  attach(port: MessagePort, message: AttachMessage) {
    const session: Session = {
      port,
      uri: message.uri,
      compilerOptions: message.compilerOptions,
    };
    this.sessions.add(session);
    port.onmessage = event => this.handlePortMessage(session, event.data);
    port.start();

    void this.ensureBackend()
      .then(() => {
        if (!this.sessions.has(session)) {
          return;
        }

        port.postMessage({ type: 'algopro/clangd-ready' });
      })
      .catch(error => {
        this.detach(session);
        port.postMessage({
          type: 'algopro/clangd-error',
          message:
            error instanceof Error ? error.message : 'Failed to start clangd',
        });
      });
  }

  private async ensureBackend() {
    if (!this.backendReady) {
      this.backendReady = this.startBackend();
    }

    return this.backendReady;
  }

  private async startBackend() {
    this.runtime = await createClangdRuntime({
      onMessage: message => this.handleBackendMessage(message),
      onError: error => this.failAllSessions(error),
    });

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(
        () => reject(new Error('Local C++ language service timed out')),
        30000
      );
      this.requestOwners.set(BACKEND_INITIALIZE_ID, {
        id: BACKEND_INITIALIZE_ID,
        session: {
          port: {
            postMessage: () => undefined,
          } as unknown as MessagePort,
          uri: '',
          compilerOptions: null,
        },
      });
      const done = (error?: Error) => {
        clearTimeout(timeoutId);
        this.backendInitializationDone = null;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      this.backendInitializationDone = done;
      this.runtime?.send({
        jsonrpc: '2.0',
        id: BACKEND_INITIALIZE_ID,
        method: 'initialize',
        params: {
          processId: null,
          rootUri: null,
          capabilities: {
            general: { positionEncodings: ['utf-16'] },
            textDocument: {
              completion: {
                completionItem: { snippetSupport: true },
              },
              hover: { contentFormat: ['markdown', 'plaintext'] },
              publishDiagnostics: { relatedInformation: true },
            },
          },
          initializationOptions: {
            compilationDatabaseChanges: {},
          },
        },
      });
    });
    this.runtime.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  }

  private backendInitializationDone: ((error?: Error) => void) | null = null;

  private handlePortMessage(session: Session, message: unknown) {
    if (!isJsonRpcMessage(message)) {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'algopro/clangd-detach'
      ) {
        this.detach(session);
      }
      return;
    }

    if (!this.runtime) {
      return;
    }

    if (message.method === 'initialize') {
      this.replyVirtualInitialize(session, message);
      return;
    }
    if (message.method === 'initialized' || message.method === 'shutdown') {
      if (message.id !== undefined) {
        session.port.postMessage({
          jsonrpc: '2.0',
          id: message.id,
          result: null,
        });
      }
      return;
    }
    if (message.method === 'exit') {
      this.detach(session);
      return;
    }

    if (message.method === 'textDocument/didOpen') {
      this.setCompileCommand(session);
    }

    const forwarded = { ...message };
    if (message.id !== undefined) {
      const backendId = `algopro/${++this.nextRequestId}`;
      this.requestOwners.set(backendId, { id: message.id, session });
      forwarded.id = backendId;
    }
    if (
      message.method === '$/cancelRequest' &&
      message.params?.id !== undefined
    ) {
      const owner = [...this.requestOwners.entries()].find(
        ([, candidate]) =>
          candidate.session === session && candidate.id === message.params.id
      );
      if (owner) {
        forwarded.params = { ...message.params, id: owner[0] };
      }
    }
    this.runtime.send(forwarded);
  }

  private replyVirtualInitialize(session: Session, message: JsonRpcMessage) {
    if (message.id === undefined) {
      return;
    }
    session.port.postMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        capabilities: {
          positionEncoding: 'utf-16',
          textDocumentSync: 2,
          completionProvider: {
            triggerCharacters: ['.', ':', '>', '"', '<'],
            resolveProvider: false,
          },
          hoverProvider: true,
          signatureHelpProvider: { triggerCharacters: ['(', ','] },
          definitionProvider: true,
          referencesProvider: true,
          documentFormattingProvider: true,
        },
        serverInfo: { name: 'clangd-wasm' },
      },
    });
  }

  private setCompileCommand(session: Session) {
    if (!this.runtime) {
      return;
    }
    const options = session.compilerOptions
      ? session.compilerOptions.split(/\s+/).filter(Boolean)
      : [];
    this.runtime.send({
      jsonrpc: '2.0',
      method: 'workspace/didChangeConfiguration',
      params: {
        settings: {
          compilationDatabaseChanges: {
            [session.uri]: [
              'clang++',
              '--target=aarch64-linux-gnu',
              '-std=c++20',
              ...options,
              session.uri,
            ],
          },
        },
      },
    });
  }

  private handleBackendMessage(message: JsonRpcMessage) {
    if (message.id === BACKEND_INITIALIZE_ID) {
      this.requestOwners.delete(BACKEND_INITIALIZE_ID);
      if ('error' in message) {
        this.backendInitializationDone?.(
          new Error(message.error?.message ?? 'clangd initialization failed')
        );
      } else {
        this.backendInitializationDone?.();
      }
      return;
    }

    if (message.id !== undefined) {
      const owner = this.requestOwners.get(message.id);
      if (!owner) {
        return;
      }
      this.requestOwners.delete(message.id);
      owner.session.port.postMessage({ ...message, id: owner.id });
      return;
    }

    const uri = message.params?.uri;
    if (typeof uri === 'string') {
      for (const session of this.sessions) {
        if (session.uri === uri) {
          session.port.postMessage(message);
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
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri: session.uri } },
    });
    if (this.sessions.size === 0) {
      void this.stop();
    }
  }

  private async stop() {
    const runtime = this.runtime;
    this.runtime = null;
    this.backendReady = null;
    this.requestOwners.clear();
    if (runtime) {
      await runtime.stop();
    }
  }

  private failAllSessions(error: Error) {
    this.backendInitializationDone?.(error);
    for (const session of this.sessions) {
      session.port.postMessage({
        type: 'algopro/clangd-error',
        message: error.message,
      });
    }
  }
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return typeof value === 'object' && value !== null && 'jsonrpc' in value;
}

function isAttachMessage(value: unknown): value is AttachMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'algopro/clangd-attach' &&
    'uri' in value &&
    typeof value.uri === 'string'
  );
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
        type: 'algopro/clangd-error',
        message: 'Expected clangd attach message',
      });
      return;
    }
    broker.attach(port, messageEvent.data);
  };
  port.addEventListener('message', onFirstMessage, { once: true });
  port.start();
};
