/**
 * DeepSeek PoW solver — WASM-based (DeepSeekHashV1, 23-round Keccak).
 *
 * Uses the same sha3_wasm_bg.wasm file used by the DeepSeek web app.
 * The wasm_solve export brute-forces the puzzle natively, which is
 * orders of magnitude faster than the pure-JS approach.
 *
 * Public API:
 *   solveDeepSeekPow({ algorithm, challenge, salt, difficulty, expire_at })
 *     -> Promise<number>  (the answer integer)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const WASM_PATH = path.join(__dirname, 'sha3_wasm_bg.wasm');

// Minimal WASI no-op shims — the WASM imports wasi_snapshot_preview1 but
// only needs the symbols to exist at instantiation time.
const wasiNoops = new Proxy({}, { get: () => () => 0 });

// Cache the instantiated WASM exports so we only load once.
let _wasmExports = null;

async function getWasmExports() {
  if (_wasmExports) return _wasmExports;

  const buf = fs.readFileSync(WASM_PATH);

  // Use no-op WASI shims directly — the WASM imports wasi_snapshot_preview1
  // symbols but never invokes them at runtime, so real WASI is not needed.
  // This avoids the Node.js ExperimentalWarning triggered by require('wasi').
  const { instance } = await WebAssembly.instantiate(buf, {
    wasi_snapshot_preview1: wasiNoops,
  });
  _wasmExports = instance.exports;

  return _wasmExports;
}

/**
 * Solve the DeepSeekHashV1 PoW puzzle using the WASM module.
 * Mirrors _WasmPoWSolver.solve() from the lumaGPT reference implementation.
 *
 * @param {{ algorithm, challenge, salt, difficulty, expire_at }} challengeData
 * @returns {Promise<number>} integer answer
 */
async function solveDeepSeekPow(challengeData) {
  const { algorithm, challenge, salt, difficulty, expire_at } = challengeData;

  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error('Unsupported PoW algorithm: ' + algorithm);
  }

  const exports = await getWasmExports();
  const memory  = exports.memory;

  const prefix = `${salt}_${expire_at}_`;

  /** Write a UTF-8 string into WASM memory via the wasm-bindgen allocator. */
  function writeStr(str) {
    const enc = Buffer.from(str, 'utf8');
    const ptr = exports.__wbindgen_export_0(enc.length, 1);
    new Uint8Array(memory.buffer).set(enc, ptr);
    return [ptr, enc.length];
  }

  // Allocate return slot on the shadow stack (-16 bytes, same as Python port).
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    const [cp, cl] = writeStr(challenge);
    const [pp, pl] = writeStr(prefix);

    // wasm_solve(retptr, challenge_ptr, challenge_len, prefix_ptr, prefix_len, difficulty_f64)
    exports.wasm_solve(retptr, cp, cl, pp, pl, Number(difficulty));

    const dv     = new DataView(memory.buffer);
    const status = dv.getInt32(retptr, /* little-endian */ true);
    if (status === 0) throw new Error('[DeepSeek PoW] No solution found within difficulty limit');
    return Math.floor(dv.getFloat64(retptr + 8, true));
  } finally {
    exports.__wbindgen_add_to_stack_pointer(16); // restore shadow stack
  }
}

module.exports = { solveDeepSeekPow };
