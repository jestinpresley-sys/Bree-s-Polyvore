import { EMBEDDED_MODEL, EMBEDDED_ASSETS } from './embedded-assets.generated.js';

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function mimeFor(filename) {
  if (filename.endsWith('.wasm')) return 'application/wasm';
  if (filename.endsWith('.onnx')) return 'application/octet-stream';
  return 'application/octet-stream';
}

// The library fetches its model/wasm files at runtime by URL (it doesn't use
// static `import` statements a bundler could see and inline for us). So
// instead we patch `fetch` to intercept those specific requests and answer
// them from the base64 data we embedded at build time — no network involved,
// even though the library itself doesn't know that. Everything else still
// goes through the real fetch untouched.
let patched = false;
function installEmbeddedFetch() {
  if (patched || typeof window === 'undefined') return;
  patched = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const filename = url.split('/').pop().split('?')[0];
    if (filename && Object.prototype.hasOwnProperty.call(EMBEDDED_ASSETS, filename)) {
      const bytes = base64ToBytes(EMBEDDED_ASSETS[filename]);
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: {
            'Content-Type': mimeFor(filename),
            'Content-Length': String(bytes.length),
          },
        })
      );
    }
    return originalFetch(input, init);
  };
}

let removeBgModulePromise = null;
function loadRemoveBgModule() {
  // Must patch fetch BEFORE the module is imported, in case it kicks off any
  // fetch during its own module-level setup rather than only when called.
  installEmbeddedFetch();
  if (!removeBgModulePromise) {
    removeBgModulePromise = import('@imgly/background-removal');
  }
  return removeBgModulePromise;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read processed image.'));
    reader.readAsDataURL(blob);
  });
}

export const hasEmbeddedModel = Object.keys(EMBEDDED_ASSETS).length > 0;

/**
 * Runs the real segmentation model on a data-URL image and resolves to a
 * PNG data URL with the background removed. Throws if the model/runtime
 * can't be loaded (e.g. build wasn't prepared, or the browser doesn't
 * support WebAssembly) — callers should fall back to the quick heuristic
 * cutout in that case.
 */
export async function aiRemoveBackground(srcDataUrl, onProgress) {
  const mod = await loadRemoveBgModule();
  const removeBackground = mod.default || mod.removeBackground || mod;
  const config = {
    output: { format: 'image/png', quality: 0.9 },
  };
  if (EMBEDDED_MODEL) config.model = EMBEDDED_MODEL;
  if (typeof onProgress === 'function') {
    config.progress = (key, current, total) => onProgress({ key, current, total });
  }
  const blob = await removeBackground(srcDataUrl, config);
  return blobToDataUrl(blob);
}
