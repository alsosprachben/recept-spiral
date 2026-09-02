#!/bin/sh
# Rebuild the WebAssembly receptor banks committed in ../public/.
#
# Needs Emscripten (emcc). The DataVec site builder has bun but NOT emcc, so the .wasm
# artifacts are committed to the repo — run this whenever the C in this directory changes
# and commit the results alongside it.
#
#   ./wasm/build.sh && bun test
#
# Sources are copies of the reference implementation in the `recept` repo
# (github.com/alsosprachben/recept): bank.c / bank_array.c are the receptor bank, and
# bank_wasm.c is the browser shim that emits RCP1 frames.
set -e
cd "$(dirname "$0")"

EXPORTS=_bank_wasm_init,_bank_wasm_free,_bank_wasm_input,_bank_wasm_process,_bank_wasm_frame,_bank_wasm_frame_size,_bank_wasm_block,_malloc,_free
COMMON="-O3 -msimd128 -fopenmp-simd -sSTANDALONE_WASM --no-entry -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sEXPORTED_FUNCTIONS=$EXPORTS"

# float64: bit-identical to the native build
# shellcheck disable=SC2086
emcc $COMMON -DBANK_CHUNK=256 \
	bank_wasm.c bank.c bank_array.c -o ../public/bank.wasm

# float32: 4 SIMD lanes instead of 2, ~1.8x faster, ~1e-5 relative error
# shellcheck disable=SC2086
emcc $COMMON -DBANK_CHUNK=512 -DBANK_REAL=float -DBANK_REAL_IS_FLOAT \
	bank_wasm.c bank.c bank_array.c -o ../public/bank_f32.wasm

ls -l ../public/bank.wasm ../public/bank_f32.wasm
