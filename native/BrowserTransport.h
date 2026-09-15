//===--- BrowserTransport.h ------------------------------------*- C++ -*-===//
//
// Browser-facing clangd transport. The JavaScript module supplies an async
// message queue and receives one JSON-RPC object at a time.
//
//===----------------------------------------------------------------------===//

#ifndef ALGOPRO_CLANGD_WASM_BROWSERTRANSPORT_H
#define ALGOPRO_CLANGD_WASM_BROWSERTRANSPORT_H

#include "Transport.h"

#include <atomic>

namespace algopro::clangd_wasm {

class BrowserTransport final : public clang::clangd::Transport {
public:
  void notify(llvm::StringRef Method, llvm::json::Value Params) override;
  void call(llvm::StringRef Method, llvm::json::Value Params,
            llvm::json::Value ID) override;
  void reply(llvm::json::Value ID,
             llvm::Expected<llvm::json::Value> Result) override;
  llvm::Error loop(MessageHandler &Handler) override;

  // Wakes loop() when the generated JavaScript runtime is being disposed.
  void requestStop();

private:
  void send(llvm::json::Value Message);
  std::atomic<bool> Stopping{false};
};

} // namespace algopro::clangd_wasm

#endif
