// onnxruntime-web ships its own copies of ort-wasm-simd-threaded(.jsep).wasm
// (~35MB combined) that several of its internal loader files reference via
// `new URL('...wasm', import.meta.url)`. Vite's asset scanner inlines each of
// those references independently (no dedup across separate inlined data
// URIs), so the same ~23MB file has ended up embedded 4x in a build — over
// 100MB of pure waste.
//
// We never actually reach this code path: ai-cutout.js always sets
// `ort.env.wasm.wasmPaths` to our own embedded-chunk blob URLs *before*
// calling `InferenceSession.create`, so onnxruntime-web's own default wasm
// files are dead weight, present only because Vite can't know that
// statically. Replacing their content with a minimal valid (but empty) wasm
// module removes the bloat with no behavior change.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Minimal valid empty WebAssembly module (magic number + version, no sections).
const EMPTY_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const STUB_MARKER_SIZE = EMPTY_WASM.length;

const TARGETS = [
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
];

for (const rel of TARGETS) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) {
    console.warn(`patch-onnxruntime: ${rel} not found, skipping (package layout may have changed).`);
    continue;
  }
  if (statSync(abs).size <= STUB_MARKER_SIZE) {
    console.log(`patch-onnxruntime: ${rel} already stubbed.`);
    continue;
  }
  writeFileSync(abs, EMPTY_WASM);
  console.log(`patch-onnxruntime: stubbed ${rel}`);
}
