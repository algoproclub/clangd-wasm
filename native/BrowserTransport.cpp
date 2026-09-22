//===--- BrowserTransport.cpp ----------------------------------*- C++ -*-===//

#include "BrowserTransport.h"

#include "Protocol.h"
#include "llvm/Support/Error.h"
#include "llvm/Support/FormatVariadic.h"
#include "llvm/Support/raw_ostream.h"

#include <cerrno>
#include <cstdlib>
#include <optional>
#include <system_error>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

// The generated JavaScript wrapper installs these functions. A null result
// from receive means the wrapper has closed the queue.
EM_JS(void, browser_transport_send, (const char *JSON), {
  globalThis.__algoproClangdPostMessage(UTF8ToString(JSON));
})
EM_ASYNC_JS(char *, browser_transport_receive, (), {
  const message = await globalThis.__algoproClangdReceiveMessage();
  if (message === null)
    return 0;
  if (typeof message !== "string")
    throw new TypeError("clangd message queue returned a non-string message");
  const bytes = lengthBytesUTF8(message) + 1;
  const pointer = _malloc(bytes);
  stringToUTF8(message, pointer, bytes);
  return pointer;
})
EM_JS(void, browser_transport_wake, (), {
  globalThis.__algoproClangdWakeMessageLoop();
})
#endif

namespace algopro::clangd_wasm {
namespace {

llvm::json::Object encodeError(llvm::Error Error) {
  std::string Message;
  clang::clangd::ErrorCode Code = clang::clangd::ErrorCode::UnknownErrorCode;
  if (llvm::Error Unhandled = llvm::handleErrors(
          std::move(Error),
          [&](const clang::clangd::LSPError &L) -> llvm::Error {
            Message = L.Message;
            Code = L.Code;
            return llvm::Error::success();
          }))
    Message = llvm::toString(std::move(Unhandled));
  return llvm::json::Object{{"message", std::move(Message)},
                            {"code", int64_t(Code)}};
}

llvm::Error decodeError(const llvm::json::Object &Object) {
  const llvm::StringRef Message =
      Object.getString("message").value_or("Unspecified error");
  if (const auto Code = Object.getInteger("code"))
    return llvm::make_error<clang::clangd::LSPError>(
        Message.str(), clang::clangd::ErrorCode(*Code));
  return llvm::createStringError(std::errc::protocol_error, "%s",
                                 Message.str().c_str());
}

bool dispatch(llvm::json::Value Message,
              clang::clangd::Transport::MessageHandler &Handler) {
  llvm::json::Object *Object = Message.getAsObject();
  if (!Object ||
      Object->getString("jsonrpc") != std::optional<llvm::StringRef>("2.0"))
    return true; // Ignore malformed client input, as JSONTransport does.

  std::optional<llvm::json::Value> ID;
  if (llvm::json::Value *Value = Object->get("id"))
    ID = std::move(*Value);

  const std::optional<llvm::StringRef> Method = Object->getString("method");
  if (!Method) {
    if (!ID)
      return true;
    if (llvm::json::Object *Error = Object->getObject("error"))
      return Handler.onReply(std::move(*ID), decodeError(*Error));
    llvm::json::Value Result = nullptr;
    if (llvm::json::Value *Value = Object->get("result"))
      Result = std::move(*Value);
    return Handler.onReply(std::move(*ID), std::move(Result));
  }

  llvm::json::Value Params = nullptr;
  if (llvm::json::Value *Value = Object->get("params"))
    Params = std::move(*Value);
  if (ID)
    return Handler.onCall(*Method, std::move(Params), std::move(*ID));
  return Handler.onNotify(*Method, std::move(Params));
}

} // namespace

void BrowserTransport::notify(llvm::StringRef Method, llvm::json::Value Params) {
  send(llvm::json::Object{{"jsonrpc", "2.0"},
                          {"method", Method},
                          {"params", std::move(Params)}});
}

void BrowserTransport::call(llvm::StringRef Method, llvm::json::Value Params,
                            llvm::json::Value ID) {
  send(llvm::json::Object{{"jsonrpc", "2.0"},
                          {"id", std::move(ID)},
                          {"method", Method},
                          {"params", std::move(Params)}});
}

void BrowserTransport::reply(llvm::json::Value ID,
                             llvm::Expected<llvm::json::Value> Result) {
  if (Result) {
    send(llvm::json::Object{{"jsonrpc", "2.0"},
                            {"id", std::move(ID)},
                            {"result", std::move(*Result)}});
    return;
  }
  send(llvm::json::Object{{"jsonrpc", "2.0"},
                          {"id", std::move(ID)},
                          {"error", encodeError(Result.takeError())}});
}

void BrowserTransport::send(llvm::json::Value Message) {
#ifdef __EMSCRIPTEN__
  std::string JSON;
  llvm::raw_string_ostream Stream(JSON);
  Stream << llvm::formatv("{0}", Message);
  Stream.flush();
  browser_transport_send(JSON.c_str());
#else
  (void)Message;
#endif
}

llvm::Error BrowserTransport::loop(MessageHandler &Handler) {
#ifndef __EMSCRIPTEN__
  return llvm::createStringError(std::errc::not_supported,
                                 "BrowserTransport requires Emscripten");
#else
  while (!Stopping.load(std::memory_order_acquire)) {
    char *Raw = browser_transport_receive();
    if (Raw == nullptr)
      return llvm::Error::success();
    std::string JSON(Raw);
    std::free(Raw);

    llvm::Expected<llvm::json::Value> Message = llvm::json::parse(JSON);
    if (!Message) {
      llvm::consumeError(Message.takeError());
      continue;
    }
    if (!dispatch(std::move(*Message), Handler))
      return llvm::Error::success();
  }
  return llvm::Error::success();
#endif
}

void BrowserTransport::requestStop() {
  Stopping.store(true, std::memory_order_release);
#ifdef __EMSCRIPTEN__
  browser_transport_wake();
#endif
}

} // namespace algopro::clangd_wasm
