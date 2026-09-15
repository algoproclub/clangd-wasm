//===--- SystemIndexBuilder.cpp --------------------------------*- C++ -*-===//
// Builds the system-only static clangd index shipped with clangd-wasm.
//
// It deliberately calls clangd's stdlib indexer. Reimplementing its symbol
// collection would lose canonical include spelling and completion metadata.

#include "Compiler.h"
#include "index/Serialization.h"
#include "index/StdLib.h"
#include "support/ThreadsafeFS.h"

#include "clang/Basic/Diagnostic.h"
#include "clang/Frontend/FrontendActions.h"
#include "llvm/ADT/STLExtras.h"
#include "llvm/ADT/SmallString.h"
#include "llvm/Support/Error.h"
#include "llvm/Support/ErrorHandling.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/Path.h"
#include "llvm/Support/VirtualFileSystem.h"
#include "llvm/Support/raw_ostream.h"

#include <cctype>
#include <cstdlib>
#include <fstream>
#include <optional>
#include <string>
#include <system_error>
#include <vector>

namespace {

using clang::CompilerInvocation;
using clang::Diagnostic;
using clang::DiagnosticConsumer;
using clang::DiagnosticsEngine;
using clang::FrontendInputFile;
using clang::SyntaxOnlyAction;
using clang::clangd::ParseInputs;
using clang::clangd::StdLibLocation;
using clang::clangd::SymbolSlab;
using clang::tooling::CompileCommand;

constexpr llvm::StringLiteral CanonicalSysroot = "/sysroot";

struct Options {
  std::string Target, Sysroot, GCCVersion, Output, Allowlist, ResourceDir;
};

class ErrorDiagnostics final : public DiagnosticConsumer {
public:
  void HandleDiagnostic(DiagnosticsEngine::Level Level,
                        const Diagnostic &Info) override {
    DiagnosticConsumer::HandleDiagnostic(Level, Info);
    SawError |= Level >= DiagnosticsEngine::Error;
  }
  bool sawError() const { return SawError; }

private:
  bool SawError = false;
};

// The native build machine sees an extracted archive at an arbitrary path,
// while the browser mounts that exact tree at /sysroot. Keeping the virtual
// names here is essential: clangd stores declaration URIs in the index.
class CanonicalSysrootFS final : public clang::clangd::ThreadsafeFS {
public:
  explicit CanonicalSysrootFS(std::string PhysicalRoot)
      : PhysicalRoot(std::move(PhysicalRoot)) {}

private:
  llvm::IntrusiveRefCntPtr<llvm::vfs::FileSystem> viewImpl() const override {
    llvm::vfs::YAMLVFSWriter Writer;
    Writer.setUseExternalNames(false);
    Writer.addDirectoryMapping(CanonicalSysroot, PhysicalRoot);
    std::string YAML;
    llvm::raw_string_ostream OS(YAML);
    Writer.write(OS);
    OS.flush();
    auto Filesystem = llvm::vfs::getVFSFromYAML(
        llvm::MemoryBuffer::getMemBufferCopy(YAML, "clangd-wasm-sysroot.yaml"),
        nullptr, "clangd-wasm-sysroot.yaml");
    if (!Filesystem)
      llvm::report_fatal_error("could not create canonical sysroot VFS");
    return llvm::IntrusiveRefCntPtr<llvm::vfs::FileSystem>(Filesystem.release());
  }

  std::string PhysicalRoot;
};

[[noreturn]] void fail(llvm::StringRef Message) {
  llvm::errs() << "SystemIndexBuilder: " << Message << '\n';
  std::exit(1);
}

void usage() {
  llvm::errs() << "usage: SystemIndexBuilder --target=TRIPLE --sysroot=DIR "
                  "--gcc-version=VERSION --output=FILE "
                  "--public-header-allowlist=FILE [--resource-dir=DIR]\n";
}

std::optional<std::string> optionValue(llvm::StringRef Argument,
                                       llvm::StringRef Name) {
  const std::string Prefix = "--" + Name.str() + "=";
  if (!Argument.starts_with(Prefix))
    return std::nullopt;
  return Argument.drop_front(Prefix.size()).str();
}

Options parseOptions(int Count, char **Arguments) {
  Options Result;
  for (int I = 1; I < Count; ++I) {
    llvm::StringRef Argument(Arguments[I]);
    if (Argument == "--help") {
      usage();
      std::exit(0);
    }
    if (auto Value = optionValue(Argument, "target"))
      Result.Target = *Value;
    else if (auto Value = optionValue(Argument, "sysroot"))
      Result.Sysroot = *Value;
    else if (auto Value = optionValue(Argument, "gcc-version"))
      Result.GCCVersion = *Value;
    else if (auto Value = optionValue(Argument, "output"))
      Result.Output = *Value;
    else if (auto Value = optionValue(Argument, "public-header-allowlist"))
      Result.Allowlist = *Value;
    else if (auto Value = optionValue(Argument, "resource-dir"))
      Result.ResourceDir = *Value;
    else
      fail(std::string("unknown argument: ") + Argument.str());
  }
  if (Result.Target.empty() || Result.Sysroot.empty() ||
      Result.GCCVersion.empty() || Result.Output.empty() ||
      Result.Allowlist.empty()) {
    usage();
    fail("all required options must be supplied");
  }
  return Result;
}

bool safeHeader(llvm::StringRef Header) {
  if (Header.empty() || Header.starts_with("/") || Header.contains(".."))
    return false;
  return llvm::all_of(Header, [](char Character) {
    return std::isalnum(static_cast<unsigned char>(Character)) ||
           Character == '_' || Character == '.' || Character == '/' ||
           Character == '+' || Character == '-';
  });
}

std::string makeUmbrella(llvm::StringRef Filename) {
  std::ifstream Input(Filename.str());
  if (!Input)
    fail(std::string("cannot read allowlist: ") + Filename.str());
  std::string Line;
  std::string Result;
  while (std::getline(Input, Line)) {
    llvm::StringRef Header = llvm::StringRef(Line).trim();
    if (Header.empty() || Header.starts_with('#'))
      continue;
    if (!safeHeader(Header))
      fail(std::string("unsafe header in allowlist: ") + Header.str());
    // Older captured toolchains may not contain every optional C++23 header.
    Result += "#if __has_include(<" + Header.str() + ">)\n#include <" +
              Header.str() + ">\n#endif\n";
  }
  if (Result.empty())
    fail("allowlist contained no headers");
  return Result;
}

std::string canonicalPath(llvm::StringRef Path) {
  llvm::SmallString<256> Result;
  if (std::error_code Error = llvm::sys::fs::real_path(Path, Result))
    fail(std::string("cannot resolve ") + Path.str() + ": " +
         Error.message());
  return std::string(Result.str());
}

void addExistingPath(std::vector<std::string> &Arguments,
                     llvm::StringRef PhysicalPath,
                     llvm::StringRef VirtualPath) {
  if (!llvm::sys::fs::is_directory(PhysicalPath))
    return;
  Arguments.emplace_back("-isystem");
  Arguments.push_back(VirtualPath.str());
}

std::vector<std::string> compilerArguments(const Options &Opt) {
  std::vector<std::string> Result = {
      "clang++", "--target=" + Opt.Target, "--sysroot=/sysroot",
      "-std=c++23", "-xc++", "-fsyntax-only",
  };
  if (!Opt.ResourceDir.empty())
    Result.push_back("-resource-dir=" + canonicalPath(Opt.ResourceDir));

  // A bare sysroot does not make Clang discover GCC's C++ headers. Support
  // both Debian native and cross-sysroot layouts, preserving common-before-
  // target-specific search order.
  llvm::SmallString<256> Root(Opt.Sysroot), Common(Root), VirtualRoot(CanonicalSysroot),
      VirtualCommon(VirtualRoot);
  llvm::sys::path::append(Common, "usr", "include", "c++", Opt.GCCVersion);
  llvm::sys::path::append(VirtualCommon, "usr", "include", "c++", Opt.GCCVersion);
  addExistingPath(Result, Common, VirtualCommon);
  llvm::SmallString<256> CommonTarget(Common);
  llvm::SmallString<256> VirtualCommonTarget(VirtualCommon);
  llvm::sys::path::append(CommonTarget, Opt.Target);
  llvm::sys::path::append(VirtualCommonTarget, Opt.Target);
  addExistingPath(Result, CommonTarget, VirtualCommonTarget);
  llvm::SmallString<256> Cross(Root);
  llvm::SmallString<256> VirtualCross(VirtualRoot);
  llvm::sys::path::append(Cross, "usr", Opt.Target, "include", "c++");
  llvm::sys::path::append(Cross, Opt.GCCVersion);
  llvm::sys::path::append(VirtualCross, "usr", Opt.Target, "include", "c++");
  llvm::sys::path::append(VirtualCross, Opt.GCCVersion);
  addExistingPath(Result, Cross, VirtualCross);
  llvm::SmallString<256> CrossTarget(Cross);
  llvm::SmallString<256> VirtualCrossTarget(VirtualCross);
  llvm::sys::path::append(CrossTarget, Opt.Target);
  llvm::sys::path::append(VirtualCrossTarget, Opt.Target);
  addExistingPath(Result, CrossTarget, VirtualCrossTarget);
  llvm::SmallString<256> Multiarch(Root);
  llvm::SmallString<256> VirtualMultiarch(VirtualRoot);
  llvm::sys::path::append(Multiarch, "usr", "include", Opt.Target);
  llvm::sys::path::append(VirtualMultiarch, "usr", "include", Opt.Target);
  addExistingPath(Result, Multiarch, VirtualMultiarch);
  llvm::SmallString<256> Includes(Root);
  llvm::SmallString<256> VirtualIncludes(VirtualRoot);
  llvm::sys::path::append(Includes, "usr", "include");
  llvm::sys::path::append(VirtualIncludes, "usr", "include");
  addExistingPath(Result, Includes, VirtualIncludes);
  llvm::SmallString<256> GCCIncludes(Root);
  llvm::SmallString<256> VirtualGCCIncludes(VirtualRoot);
  llvm::sys::path::append(GCCIncludes, "usr", "lib", "gcc", Opt.Target);
  llvm::sys::path::append(GCCIncludes, Opt.GCCVersion, "include");
  llvm::sys::path::append(VirtualGCCIncludes, "usr", "lib", "gcc", Opt.Target);
  llvm::sys::path::append(VirtualGCCIncludes, Opt.GCCVersion, "include");
  addExistingPath(Result, GCCIncludes, VirtualGCCIncludes);
  return Result;
}

std::unique_ptr<CompilerInvocation>
makeInvocation(const Options &Opt, const clang::clangd::ThreadsafeFS &Filesystem,
               DiagnosticConsumer &Diagnostics) {
  constexpr llvm::StringLiteral MainFile = "/clangd-wasm-system-index.cc";
  std::vector<std::string> Arguments = compilerArguments(Opt);
  Arguments.push_back(MainFile.str());
  ParseInputs Inputs{CompileCommand("/", MainFile, std::move(Arguments), ""),
                     &Filesystem, ""};
  auto Invocation = clang::clangd::buildCompilerInvocation(Inputs, Diagnostics);
  if (!Invocation || Invocation->getFrontendOpts().Inputs.size() != 1)
    fail("could not create a compiler invocation");
  return Invocation;
}

void checkUmbrella(const std::string &Umbrella, const Options &Opt,
                   const clang::clangd::ThreadsafeFS &Filesystem) {
  ErrorDiagnostics Diagnostics;
  auto Invocation = makeInvocation(Opt, Filesystem, Diagnostics);
  FrontendInputFile Input = Invocation->getFrontendOpts().Inputs.front();
  auto Instance = clang::clangd::prepareCompilerInstance(
      std::move(Invocation), nullptr,
      llvm::MemoryBuffer::getMemBuffer(Umbrella, Input.getFile()),
      Filesystem.view(std::nullopt), Diagnostics);
  if (!Instance)
    fail("could not prepare compiler for header validation");
  SyntaxOnlyAction Action;
  if (!Action.BeginSourceFile(*Instance, Input))
    fail("could not begin header validation");
  if (llvm::Error Error = Action.Execute())
    fail(std::string("header validation failed: ") +
         llvm::toString(std::move(Error)));
  Action.EndSourceFile();
  if (Diagnostics.sawError() ||
      Instance->getDiagnostics().hasUncompilableErrorOccurred())
    fail("header validation reported compiler errors");
}

void writeIndex(const SymbolSlab &Symbols, llvm::StringRef Filename) {
  if (Symbols.empty())
    fail("indexer returned no symbols");
  std::error_code Error;
  llvm::raw_fd_ostream Output(Filename, Error, llvm::sys::fs::OF_None);
  if (Error)
    fail(std::string("cannot write index: ") + Error.message());
  clang::clangd::IndexFileOut Serialized;
  Serialized.Symbols = &Symbols;
  Output << Serialized;
  Output.flush();
  if (Output.has_error())
    fail("failed while writing index");
}

} // namespace

int main(int Count, char **Arguments) {
  const Options Opt = parseOptions(Count, Arguments);
  if (!llvm::sys::fs::is_directory(Opt.Sysroot))
    fail("sysroot is not a directory");

  const std::string Umbrella = makeUmbrella(Opt.Allowlist);
  CanonicalSysrootFS Filesystem(canonicalPath(Opt.Sysroot));
  checkUmbrella(Umbrella, Opt, Filesystem);

  ErrorDiagnostics Diagnostics;
  auto Invocation = makeInvocation(Opt, Filesystem, Diagnostics);
  StdLibLocation Location;
  // Filtering to the sysroot guarantees student files cannot enter this index.
  Location.Paths.emplace_back(CanonicalSysroot.str());
  SymbolSlab Symbols = clang::clangd::indexStandardLibrary(
      Umbrella, std::move(Invocation), Location, Filesystem);
  if (Diagnostics.sawError())
    fail("compiler invocation reported errors before indexing");
  writeIndex(Symbols, Opt.Output);
  llvm::outs() << "Wrote " << Symbols.size() << " system symbols to "
               << Opt.Output << '\n';
}
