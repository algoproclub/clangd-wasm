//===--- ClangdWasmMain.cpp ------------------------------------*- C++ -*-===//
// The WASM entry point deliberately embeds clangd's supported LSP API instead
// of emulating stdin/stdout. JavaScript owns the queue and multiplexes clients.

#include "BrowserTransport.h"

#include "ClangdLSPServer.h"
#include "ClangdServer.h"
#include "CodeComplete.h"
#include "index/Serialization.h"
#include "support/ThreadsafeFS.h"
#include "llvm/Support/Error.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include <memory>
#include <string>

namespace {

constexpr llvm::StringLiteral SystemIndexPath = "/assets/system.index";

std::unique_ptr<clang::clangd::SymbolIndex> loadSystemIndex() {
  auto Index = clang::clangd::loadIndex(
      SystemIndexPath, clang::clangd::SymbolOrigin::Static,
      /*UseDex=*/true, /*SupportContainedRefs=*/false);
  return Index;
}

clang::clangd::ClangdLSPServer::Options makeOptions(
    const clang::clangd::SymbolIndex *SystemIndex) {
  clang::clangd::ClangdLSPServer::Options Options;
  Options.AsyncThreadsCount = 0;
  Options.BuildDynamicSymbolIndex = false;
  Options.BackgroundIndex = false;
  Options.UseDirBasedCDB = false;
  Options.UseDirtyHeaders = false;
  Options.StorePreamblesInMemory = true;
  Options.StaticIndex = SystemIndex;
  Options.CodeComplete.ForceLoadPreamble = true;
  Options.CodeComplete.InsertIncludes =
      clang::clangd::Config::HeaderInsertionPolicy::IWYU;
  Options.CodeComplete.AllScopes = true;
  Options.CodeComplete.EnableInsertReplace = false;
  Options.CodeComplete.RankingModel =
      clang::clangd::CodeCompleteOptions::DecisionForest;
  return Options;
}

algopro::clangd_wasm::BrowserTransport *ActiveTransport = nullptr;

} // namespace

// Emscripten invokes this asynchronously. It returns once clangd receives an
// LSP exit notification or the JS runtime disposes its message queue.
extern "C" {
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int clangd_wasm_run() {
  auto SystemIndex = loadSystemIndex();
  if (!SystemIndex)
    return 2;

  clang::clangd::RealThreadsafeFS Filesystem;
  algopro::clangd_wasm::BrowserTransport Transport;
  ActiveTransport = &Transport;
  const auto Options = makeOptions(SystemIndex.get());
  clang::clangd::ClangdLSPServer Server(Transport, Filesystem, Options);
  const bool CleanShutdown = Server.run();
  ActiveTransport = nullptr;
  return CleanShutdown ? 0 : 1;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void clangd_wasm_stop() {
  if (ActiveTransport)
    ActiveTransport->requestStop();
}
}
