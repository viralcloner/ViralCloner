// DeepSeek PoW — runs inside a Node.js Worker Thread so the main Electron
// thread is never blocked by the synchronous Keccak brute-force loop.

const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CHUNK_38401 = fs.readFileSync(path.join(__dirname, 'chunk_38401.js'), 'utf8');
const CHUNK_60816 = fs.readFileSync(path.join(__dirname, 'chunk_60816.js'), 'utf8');

function buildSandbox() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Promise,
    Buffer,
    Uint8Array,
    Uint32Array,
    Int8Array,
    Int32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    SharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : undefined,
    DataView,
    Symbol,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Reflect,
    Proxy,
    TypeError,
    RangeError,
    Error,
    Number,
    String,
    Object,
    Array,
    Math,
    JSON,
    Date,
    RegExp,
    importScripts(url) {
      if (url && url.includes('60816')) {
        vm.runInContext(CHUNK_60816, sandbox, { filename: 'chunk_60816.js' });
      }
    },
    // The DeepSeek chunk calls postMessage() to deliver the answer.
    // Forward it directly to the main thread via parentPort.
    postMessage(msg) {
      parentPort.postMessage(msg);
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CHUNK_38401, sandbox, { filename: 'chunk_38401.js' });
  return sandbox;
}

let sandbox;
try {
  sandbox = buildSandbox();
} catch (e) {
  parentPort.postMessage({ type: 'pow-error', error: { message: 'Failed to build sandbox: ' + e.message } });
  process.exit(1);
}

// The chunk wires up sandbox.onmessage asynchronously — poll until ready.
function waitForReady() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (typeof sandbox.onmessage === 'function') {
        resolve();
      } else if (Date.now() - start > 5000) {
        reject(new Error('[DeepSeek PoW Worker] onmessage never registered'));
      } else {
        setTimeout(check, 20);
      }
    };
    check();
  });
}

waitForReady()
  .then(() => {
    // Tell the main thread we are ready to accept challenges.
    parentPort.postMessage({ type: 'ready' });

    // Each message from the main thread is a challenge object.
    // The synchronous hash loop runs here in the worker thread,
    // leaving the Electron main thread event loop completely free.
    parentPort.on('message', (challenge) => {
      sandbox.onmessage({
        data: {
          type: 'pow-challenge',
          challenge: {
            algorithm: challenge.algorithm || 'DeepSeekHashV1',
            challenge: challenge.challenge,
            salt: challenge.salt,
            difficulty: challenge.difficulty,
            signature: challenge.signature,
            expireAt: challenge.expire_at,
          },
        },
      });
    });
  })
  .catch((err) => {
    parentPort.postMessage({ type: 'pow-error', error: { message: err.message } });
    process.exit(1);
  });
