import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const clangdAssetNames = [
  'clangd-runtime.mjs',
  'clangd.wasm',
  'headers.data',
  'system.index',
] as const;

export type ClangdAssetName = (typeof clangdAssetNames)[number];

export interface ClangdAssetManifest {
  packageVersion: string;
  llvmRevision: string;
  emscriptenVersion: string;
  targetTriple: 'aarch64-linux-gnu';
  gccVersion: string;
  sysrootDigest: string;
  indexDigest: string;
  thinLto: true;
  decisionForest: true;
  files: Record<ClangdAssetName, { sha256: string; bytes: number }>;
}

export interface ClangdAssets {
  baseUrl: string;
  manifest: string;
  runtime: string;
  wasm: string;
  headers: string;
  index: string;
}

export interface ClangdRuntime {
  send(message: unknown): void;
  stop(): Promise<void>;
}

interface GeneratedRuntime {
  send(message: unknown): void;
  stop(): Promise<void> | void;
}

interface GeneratedRuntimeModule {
  createClangdRuntime(options: {
    assets: ClangdAssets;
    onMessage(message: unknown): void;
    onError(error: Error): void;
  }): Promise<GeneratedRuntime>;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

/** Resolves URLs for assets copied from this npm package. */
export function resolveClangdAssets(assetBaseUrl: string): ClangdAssets {
  const baseUrl = normalizeBaseUrl(assetBaseUrl);
  return {
    baseUrl,
    manifest: `${baseUrl}manifest.json`,
    runtime: `${baseUrl}clangd-runtime.mjs`,
    wasm: `${baseUrl}clangd.wasm`,
    headers: `${baseUrl}headers.data`,
    index: `${baseUrl}system.index`,
  };
}

/** Reads and validates the manifest served beside the generated assets. */
export async function loadClangdManifest(
  assetBaseUrl: string,
  fetcher: typeof fetch = fetch
): Promise<ClangdAssetManifest> {
  const response = await fetcher(resolveClangdAssets(assetBaseUrl).manifest);
  if (!response.ok) {
    throw new Error(
      `Could not load clangd asset manifest: HTTP ${response.status}`
    );
  }

  const manifest: unknown = await response.json();
  if (!isManifest(manifest))
    throw new Error('clangd asset manifest has an invalid shape');
  return manifest;
}

/** Starts the generated Emscripten bridge; the host owns JSON-RPC multiplexing. */
export async function createClangdRuntime(options: {
  assetBaseUrl: string;
  onMessage(message: unknown): void;
  onError(error: Error): void;
}): Promise<ClangdRuntime> {
  const assets = resolveClangdAssets(options.assetBaseUrl);
  const runtimeModule = (await import(
    /* webpackIgnore: true */ assets.runtime
  )) as GeneratedRuntimeModule;
  if (typeof runtimeModule.createClangdRuntime !== 'function') {
    throw new Error(
      'Generated clangd runtime does not export createClangdRuntime'
    );
  }
  const runtime = await runtimeModule.createClangdRuntime({
    ...options,
    assets,
  });
  return {
    send: message => runtime.send(message),
    stop: async () => {
      await runtime.stop();
    },
  };
}

/** Node-only helper that copies a complete package artifact to static hosting. */
export async function copyClangdAssets(outputDirectory: string): Promise<{
  manifest: ClangdAssetManifest;
  outputDirectory: string;
}> {
  const packageDirectory = dirname(fileURLToPath(import.meta.url));
  const assetDirectory = resolve(packageDirectory, '../assets');
  const manifestPath = resolve(assetDirectory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  if (!isManifest(manifest))
    throw new Error('Packaged clangd asset manifest has an invalid shape');

  await mkdir(outputDirectory, { recursive: true });
  await cp(manifestPath, resolve(outputDirectory, 'manifest.json'));
  await Promise.all(
    clangdAssetNames.map(name =>
      cp(resolve(assetDirectory, name), resolve(outputDirectory, name))
    )
  );
  return { manifest, outputDirectory: resolve(outputDirectory) };
}

/** Returns a file URL suitable for Node-only asset inspection. */
export function clangdAssetDirectoryUrl(directory: string): string {
  return pathToFileURL(`${resolve(directory)}/`).href;
}

function isManifest(value: unknown): value is ClangdAssetManifest {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Partial<ClangdAssetManifest>;
  if (
    manifest.targetTriple !== 'aarch64-linux-gnu' ||
    manifest.thinLto !== true ||
    manifest.decisionForest !== true ||
    typeof manifest.packageVersion !== 'string' ||
    typeof manifest.llvmRevision !== 'string' ||
    typeof manifest.emscriptenVersion !== 'string' ||
    typeof manifest.gccVersion !== 'string' ||
    typeof manifest.sysrootDigest !== 'string' ||
    typeof manifest.indexDigest !== 'string' ||
    typeof manifest.files !== 'object' ||
    manifest.files === null
  )
    return false;

  return clangdAssetNames.every(name => {
    const file = manifest.files?.[name];
    return (
      typeof file?.sha256 === 'string' &&
      /^[a-f0-9]{64}$/i.test(file.sha256) &&
      typeof file.bytes === 'number' &&
      Number.isSafeInteger(file.bytes) &&
      file.bytes > 0
    );
  });
}
