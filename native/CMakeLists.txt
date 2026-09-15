# This directory is configured through LLVM_EXTERNAL_PROJECTS=clangd_wasm.
# clangDaemon is an internal LLVM target, therefore this tool must be built in
# the same source tree as clangd rather than against an installed LLVM SDK.

add_executable(clangd_wasm_system_index_builder SystemIndexBuilder.cpp)
set_target_properties(clangd_wasm_system_index_builder PROPERTIES
  OUTPUT_NAME SystemIndexBuilder
  RUNTIME_OUTPUT_DIRECTORY "${LLVM_RUNTIME_OUTPUT_INTDIR}"
)
target_compile_features(clangd_wasm_system_index_builder PRIVATE cxx_std_17)
target_include_directories(clangd_wasm_system_index_builder PRIVATE
  "${LLVM_MAIN_SRC_DIR}/../clang/include"
  "${LLVM_BINARY_DIR}/tools/clang/include"
  "${LLVM_MAIN_SRC_DIR}/../clang-tools-extra"
  "${LLVM_MAIN_SRC_DIR}/../clang-tools-extra/clangd"
)
# clangDaemon owns the clangd compiler-invocation and index APIs. This target
# pins the helper to the exact revision used for the browser engine.
target_link_libraries(clangd_wasm_system_index_builder PRIVATE clangDaemon)

add_executable(clangd-wasm-runtime
  BrowserTransport.cpp
  ClangdWasmMain.cpp
)
set_target_properties(clangd-wasm-runtime PROPERTIES
  OUTPUT_NAME clangd-runtime
  RUNTIME_OUTPUT_DIRECTORY "${LLVM_RUNTIME_OUTPUT_INTDIR}"
)
target_compile_features(clangd-wasm-runtime PRIVATE cxx_std_17)
target_include_directories(clangd-wasm-runtime PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${LLVM_MAIN_SRC_DIR}/../clang/include"
  "${LLVM_BINARY_DIR}/tools/clang/include"
  "${LLVM_MAIN_SRC_DIR}/../clang-tools-extra"
  "${LLVM_MAIN_SRC_DIR}/../clang-tools-extra/clangd"
)
target_link_libraries(clangd-wasm-runtime PRIVATE clangDaemon)

if(EMSCRIPTEN)
  if(NOT DEFINED CLANGD_WASM_SYSROOT OR NOT IS_DIRECTORY "${CLANGD_WASM_SYSROOT}")
    message(FATAL_ERROR "Set CLANGD_WASM_SYSROOT to the extracted captured sysroot")
  endif()
  target_link_options(clangd-wasm-runtime PRIVATE
    "-sASYNCIFY"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sENVIRONMENT=worker"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORTED_FUNCTIONS=['_clangd_wasm_run','_clangd_wasm_stop']"
    "-sEXPORTED_RUNTIME_METHODS=['ccall']"
    "-sFORCE_FILESYSTEM=1"
    "--preload-file"
    "${CLANGD_WASM_SYSROOT}@/sysroot"
    "--no-entry"
  )
endif()
