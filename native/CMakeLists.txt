if(CMAKE_CROSSCOMPILING)
  include(CrossCompile)
  build_native_tool(clangd-indexer CLANGD_WASM_NATIVE_INDEXER)
  add_custom_target(clangd-wasm-native-indexer
    DEPENDS "${CLANGD_WASM_NATIVE_INDEXER}"
  )
endif()

# clangd-indexer is declared with add_clang_executable rather than
# add_clang_tool, so upstream does not add this dependency automatically.
add_dependencies(clangd-indexer clang-resource-headers)

add_executable(clangd-wasm-runtime
  BrowserTransport.cpp
  ClangdWasmMain.cpp
)
set_target_properties(clangd-wasm-runtime PROPERTIES
  OUTPUT_NAME clangd-runtime
  RUNTIME_OUTPUT_DIRECTORY "${LLVM_RUNTIME_OUTPUT_INTDIR}"
)
target_compile_features(clangd-wasm-runtime PRIVATE cxx_std_17)
llvm_update_compile_flags(clangd-wasm-runtime)
target_include_directories(clangd-wasm-runtime PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"
  "${LLVM_MAIN_SRC_DIR}/../clang/include"
  "${LLVM_BINARY_DIR}/tools/clang/include"
  "${LLVM_MAIN_SRC_DIR}/../clang-tools-extra"
  "${LLVM_MAIN_SRC_DIR}/../clang-tools-extra/clangd"
  "${LLVM_MAIN_SRC_DIR}/../clang-tools-extra/include-cleaner/include"
)
target_link_libraries(clangd-wasm-runtime PRIVATE clangDaemon)

if(EMSCRIPTEN)
  if(NOT DEFINED CLANGD_WASM_SYSROOT OR NOT IS_DIRECTORY "${CLANGD_WASM_SYSROOT}")
    message(FATAL_ERROR "Set CLANGD_WASM_SYSROOT to the extracted captured sysroot")
  endif()
  include(GetClangResourceDir)
  get_clang_resource_dir(CLANGD_WASM_RESOURCE_DIR
    PREFIX "${LLVM_LIBRARY_OUTPUT_INTDIR}/.."
  )
  cmake_path(GET CLANGD_WASM_RESOURCE_DIR FILENAME CLANGD_WASM_RESOURCE_VERSION)
  set(CLANGD_WASM_RESOURCE_INCLUDE_DIR "${CLANGD_WASM_RESOURCE_DIR}/include")
  add_dependencies(clangd-wasm-runtime clang-resource-headers)
  target_link_options(clangd-wasm-runtime PRIVATE
    "-sJSPI"
    "-sJSPI_EXPORTS=['clangd_wasm_run']"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sINITIAL_HEAP=134217728"
    "-sSTACK_SIZE=4194304"
    "-sENVIRONMENT=worker"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORTED_FUNCTIONS=['_clangd_wasm_run','_clangd_wasm_stop','_malloc']"
    "-sEXPORTED_RUNTIME_METHODS=['ccall','FS','HEAPU8']"
    "-sFORCE_FILESYSTEM=1"
    "SHELL:--preload-file ${CLANGD_WASM_SYSROOT}@/sysroot"
    "SHELL:--preload-file ${CLANGD_WASM_RESOURCE_INCLUDE_DIR}@/lib/clang/${CLANGD_WASM_RESOURCE_VERSION}/include"
    "--no-entry"
  )
endif()
