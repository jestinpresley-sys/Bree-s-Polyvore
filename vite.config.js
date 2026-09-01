import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    // Any asset Vite can statically see (imported via `import x from './y'`)
    // gets inlined as a base64 data URI instead of emitted as a separate file.
    assetsInlineLimit: Infinity,
    cssCodeSplit: false,
    // The embedded model/wasm data pushes this file well past Vite's default
    // warning size — that's expected for a single-file offline build.
    chunkSizeWarningLimit: 100000,
  },
});
