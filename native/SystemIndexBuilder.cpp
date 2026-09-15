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
#include "llvm/Support/YAMLParser.h"
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
  std::vector<std::string> IncludeDirectories;
};

class ErrorDiagnostics final : public DiagnosticConsumer {
public:
  void HandleDiagnostic(DiagnosticsEngine::Level Level,
                        const Diagnostic &Info) override {
    DiagnosticConsumer::HandleDiagnostic(Level, Info);
    if (Level < DiagnosticsEngine::Error)
      return;
    SawError = true;
    llvm::SmallString<256> Message;
    Info.FormatDiagnostic(Message);
    llvm::errs() << "SystemIndexBuilder: " << Message << '\n';
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
    std::string YAML;
    llvm::raw_string_ostream OS(YAML);
    // YAMLVFSWriter expands directory mappings into virtual directories and
    // loses their external target. A RedirectingFileSystem directory remap is
    // what allows /sysroot/usr/... to resolve into the captured tree.
    OS << "{\n"
          "  'version': 0,\n"
          "  'use-external-names': 'false',\n"
          "  'roots': [\n"
          "    {\n"
          "      'type': 'directory',\n"
          "      'name': \"/sysroot\",\n"
          "      'external-contents': \""
       << llvm::yaml::escape(PhysicalRoot) << "\"\n"
          "    }\n"
          "  ]\n"
          "}\n";
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
                  "--public-header-allowlist=FILE --include-dir=DIR "
                  "[--include-dir=DIR ...] [--resource-dir=DIR]\n";
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
    else if (auto Value = optionValue(Argument, "include-dir"))
      Result.IncludeDirectories.push_back(*Value);
    else
      fail(std::string("unknown argument: ") + Argument.str());
  }
  if (Result.Target.empty() || Result.Sysroot.empty() ||
      Result.GCCVersion.empty() || Result.Output.empty() ||
      Result.Allowlist.empty() || Result.IncludeDirectories.empty()) {
    usage();
    fail("all required options must be supplied");
  }
  for (const std::string &Directory : Result.IncludeDirectories)
    if (!llvm::StringRef(Directory).starts_with("/usr/") ||
        llvm::StringRef(Directory).contains(".."))
      fail(std::string("unsafe captured include directory: ") + Directory);
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
  // Match clangd's upstream stdlib umbrella: a missing <vector> must fail
  // loudly rather than making every guarded include disappear silently.
  std::string Result = "#if !__has_include(<vector>)\n"
                       "#error Captured include directories cannot find <vector>\n"
                       "#endif\n";
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

  // Use the compiler's captured search order. The GCC version string alone
  // cannot reconstruct it (for example, GCC 13.3.0 uses c++/13 on Debian).
  for (const std::string &Directory : Opt.IncludeDirectories) {
    const std::string Physical = Opt.Sysroot + Directory;
    const std::string Virtual = CanonicalSysroot.str() + Directory;
    addExistingPath(Result, Physical, Virtual);
  }
  return Result;
}

void verifyCapturedHeaderMapping(const Options &Opt,
                                 const clang::clangd::ThreadsafeFS &Filesystem) {
  const auto View = Filesystem.view(std::nullopt);
  for (const std::string &Directory : Opt.IncludeDirectories) {
    const std::string Physical = Opt.Sysroot + Directory + "/vector";
    if (!llvm::sys::fs::is_regular_file(Physical))
      continue;
    const std::string Virtual = CanonicalSysroot.str() + Directory + "/vector";
    if (!View->exists(Virtual))
      fail(std::string("VFS cannot map captured <vector>: ") + Virtual);
    return;
  }
  fail("captured include directories do not contain <vector>");
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
  verifyCapturedHeaderMapping(Opt, Filesystem);
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
