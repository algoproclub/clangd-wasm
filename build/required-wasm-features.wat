;; This tiny module is compiled into src/required-wasm-features.ts.
;; WebAssembly.validate() accepts it only when the browser supports both
;; bulk-memory operations (memory.copy) and tail calls (return_call).
(module
  (memory 1)
  (func $return-target)
  (func (export "test")
    i32.const 0
    i32.const 0
    i32.const 0
    memory.copy
    return_call $return-target))
