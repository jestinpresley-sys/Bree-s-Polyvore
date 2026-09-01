# Cutting Table (AI build)

Same app as the single-file version, but the "Clip the background" modal
now has two modes:

- **AI cutout** — a real segmentation model (`@imgly/background-removal`,
  running fully client-side via WebAssembly). Handles busy/patterned
  backgrounds much better than color-distance flood fill.
- **Quick cutout** — the original instant, no-model heuristic, kept as a
  fallback and for plain backgrounds where it's already good enough.

The build embeds the model and WASM runtime directly into one HTML file
as base64, so the **person you hand it to needs no internet, no install,
nothing** — just double-click it, same as the plain single-file version.

## Build steps (needs internet — do this on your own machine)

```bash
npm install
npm run build
```

`npm run build` does three things:

1. `prepare-assets` — downloads the real ONNX model + WASM runtime files
   (~54MB raw for the default "small/quantized" tier — the package now
   ships them as content-hashed chunks + a `resources.json` manifest
   rather than plain named files, which the script reassembles) and
   writes them into `src/embedded-assets.generated.js` as base64.
2. `patch-onnxruntime.mjs` — neutralizes two large `.wasm` files bundled
   *inside* `onnxruntime-web` itself that several of its internal loader
   files reference independently. Vite inlines each reference as its own
   base64 copy with no deduplication, which without this step bloats the
   final file to 200MB+ for data that's never actually read (the app
   always overrides `wasmPaths` to use its own embedded chunks before
   creating a session). Safe no-op if you don't hit this — see
   `scripts/patch-onnxruntime.mjs` for the full explanation.
3. `vite build` — bundles everything (app code + embedded assets) into a
   single file at `dist/index.html`.

That `dist/index.html` is the file to send your friend — **~78MB**
(built and verified: AI cutout runs correctly end-to-end from this exact
file, including the chunk-reconstruction and onnxruntime-web patch).
`npm run build` already runs Vite with a bumped Node heap
(`--max-old-space-size=6144`) baked in, since bundling a ~72MB base64
string blows well past V8's default heap limit and crashes otherwise.

### Trying it first without the full offline build

`npm run dev` starts a local dev server that fetches the model from
IMG.LY's CDN over the network instead of using embedded data — good for
confirming the AI cutout actually works end-to-end before you commit to
the slower `prepare-assets` + `build` step.

## If something breaks

- **`npm install` warns/fails about a peer dependency version** —
  `@imgly/background-removal` pins a specific `onnxruntime-web` version
  that changes between releases; the one in `package.json` here may be
  stale by the time you run this. Check the version it actually wants
  (the npm warning will say) and adjust `package.json` accordingly.
- **`prepare-assets` fails to download or extract** — it fetches
  `https://staticimgly.com/@imgly/background-removal-data/<version>/package.tgz`
  and shells out to the system `tar` to extract it. If `tar` isn't
  available (unlikely, but possible on some Windows setups), extract
  `package.tgz` by hand into `.assets-tmp/` and re-run the script — it
  picks up from there.
- **AI cutout throws in the browser console** — most likely cause is
  `@imgly/background-removal`'s bundled code trying to `fetch` an asset
  filename that doesn't match what `prepare-assets` embedded. Open
  `src/embedded-assets.generated.js` and compare its keys against what
  the console error is requesting.
- **It works but is slow** — expected. Without a real server (which the
  double-click, no-install use case rules out), the browser can't set
  the cross-origin-isolation headers that let the model run
  multi-threaded, so it falls back to single-threaded WASM. A few
  seconds to ~15s per photo on a modest laptop wouldn't be surprising.
  The app-level fix, if it matters to you, is the "small local server"
  path we didn't pick this time.
- **Whatever goes wrong, Quick cutout still works** — it has no
  dependency on any of this, so the app is never left without a working
  background-remove option.

## Cross-device board sync (optional)

By default, saved boards live only in that browser's `localStorage` — fine
for one device, gone if she clears browser data or switches phones. To make
boards follow her across devices, wire up a free Supabase project:

1. Create a project at [supabase.com](https://supabase.com) (free tier).
2. In the SQL editor, run:
   ```sql
   create table boards (
     id text primary key,
     data jsonb not null default '[]'::jsonb,
     updated_at timestamptz not null default now()
   );
   alter table boards enable row level security;
   create policy "anon read" on boards for select using (true);
   create policy "anon write" on boards for insert with check (true);
   create policy "anon update" on boards for update using (true);
   ```
3. In Project Settings → API, copy the **Project URL** and **anon public**
   key.
4. Copy `.env.example` to `.env` and fill in those two values.
5. `npm run dev` (or rebuild) — boards now sync to Supabase automatically,
   still falling back to the local copy when offline.

This is unauthenticated by design (no login for her to deal with) — anyone
with the URL and anon key could read/write that table, which is an
acceptable trade for a single-friend, non-sensitive use case. Don't reuse
this table/project for anything more sensitive later without adding real
auth.

## Changing the model size/quality

Edit `MODEL` in `scripts/fetch-assets.mjs`:

- `isnet_quint8` (default here) — quantized, ~40MB, occasional artifacts.
- `isnet_fp16` — the library's own default, ~80MB, better quality.
- `isnet` — full precision, largest, best quality.

Re-run `npm run prepare-assets && npm run build` after changing it.

## Project layout

```
index.html                       Vite entry (same markup/CSS as the single-file app)
src/main.js                      Boots the app on DOM ready
src/app.js                       Ported app logic (canvas, gallery, localStorage) + AI/Quick mode wiring
src/ai-cutout.js                 Wraps @imgly/background-removal, intercepts its asset fetches
src/embedded-assets.generated.js Auto-generated by prepare-assets — do not hand-edit
scripts/fetch-assets.mjs         Downloads + base64-encodes the model/runtime
vite.config.js                   vite-plugin-singlefile + assetsInlineLimit: Infinity
```
