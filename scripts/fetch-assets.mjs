// Downloads the @imgly/background-removal model + WASM runtime files and
// writes them into src/embedded-assets.generated.js as base64 strings, so
// the final Vite build has zero runtime network dependencies.
//
// This runs once, on YOUR machine, with a real internet connection. The
// person you hand the built HTML file to needs none of this — it's already
// baked in.
//
// I (Claude) could not run or test this script myself: my sandbox has no
// network access, so I've built it directly from @imgly/background-removal's
// published docs rather than a live test run. If a filename or URL below has
// shifted since, the error messages should point at what to fix — see
// README.md's "If something breaks" section.

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, '.assets-tmp');
const OUT_FILE = path.join(ROOT, 'src', 'embedded-assets.generated.js');

// 'isnet_quint8' is the quantized ~40MB tier (smallest). Switch to
// 'isnet_fp16' (~80MB, the library default, better quality) or 'isnet'
// (largest, best quality) if file size isn't a concern for your friend.
const MODEL = process.env.CUTTING_TABLE_MODEL || 'isnet_quint8';

function readPkgVersion(pkgName) {
  const pkgJsonPath = path.join(ROOT, 'node_modules', ...pkgName.split('/'), 'package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new Error(
      `Can't find ${pkgJsonPath}. Run "npm install" before "npm run prepare-assets".`
    );
  }
  return JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version;
}

async function downloadFile(url, destPath) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
  }
  await pipeline(res.body, createWriteStream(destPath));
}

function extractTgz(tgzPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  // Shells out to the system `tar` (present by default on macOS, Linux, and
  // modern Windows). If this fails on your machine, extract package.tgz by
  // hand into destDir and re-run this script — it picks up where it left off.
  const result = spawnSync('tar', ['-xzf', tgzPath, '-C', destDir], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(
      `"tar" failed to extract ${tgzPath}. Extract it manually into ${destDir} and re-run this script.`
    );
  }
}

async function collectAssetFiles(distDir, model) {
  const entries = await readdir(distDir, { withFileTypes: true });
  const files = entries.filter(e => e.isFile()).map(e => e.name);

  const wasmFiles = files.filter(f => f.endsWith('.wasm'));
  // Grab every onnx file matching the chosen model tier, plus a bare
  // "model.onnx" fallback some versions ship instead of a suffixed name.
  const onnxFiles = files.filter(
    f => f.endsWith('.onnx') && (f.includes(model) || f === 'model.onnx')
  );

  if (onnxFiles.length === 0) {
    console.warn(
      `Warning: no .onnx file matched model "${model}" in ${distDir}.\n` +
      `Files found: ${files.join(', ')}\n` +
      `Falling back to embedding every .onnx file found (larger output).`
    );
    onnxFiles.push(...files.filter(f => f.endsWith('.onnx')));
  }

  return [...wasmFiles, ...onnxFiles];
}

async function main() {
  console.log(`Preparing embedded assets (model tier: ${MODEL})\n`);

  const version = readPkgVersion('@imgly/background-removal');
  console.log(`@imgly/background-removal version: ${version}`);

  if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  const tgzUrl = `https://staticimgly.com/@imgly/background-removal-data/${version}/package.tgz`;
  const tgzPath = path.join(TMP_DIR, 'package.tgz');
  await downloadFile(tgzUrl, tgzPath);

  extractTgz(tgzPath, TMP_DIR);

  const distDir = path.join(TMP_DIR, 'package', 'dist');
  if (!existsSync(distDir)) {
    throw new Error(
      `Expected ${distDir} after extraction but it's missing. ` +
      `The archive layout may have changed — check ${TMP_DIR} by hand.`
    );
  }

  const assetFiles = await collectAssetFiles(distDir, MODEL);
  if (assetFiles.length === 0) {
    throw new Error(`No .onnx/.wasm files found in ${distDir}.`);
  }

  console.log(`\nEmbedding ${assetFiles.length} file(s):`);
  const embedded = {};
  let totalBytes = 0;
  for (const name of assetFiles) {
    const filePath = path.join(distDir, name);
    const buf = await readFile(filePath);
    totalBytes += buf.length;
    console.log(`  - ${name} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
    embedded[name] = buf.toString('base64');
  }
  console.log(`Total embedded size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB\n`);

  const header =
    '// AUTO-GENERATED by scripts/fetch-assets.mjs — do not edit by hand.\n' +
    '// Regenerate with: npm run prepare-assets\n';
  const body = `export const EMBEDDED_MODEL = ${JSON.stringify(MODEL)};\nexport const EMBEDDED_ASSETS = ${JSON.stringify(embedded)};\n`;
  writeFileSync(OUT_FILE, header + body);
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)}`);

  await rm(TMP_DIR, { recursive: true, force: true });
  console.log('\nDone. Now run: npm run build (or just "vite build" if prepare-assets already ran)');
}

main().catch(err => {
  console.error('\nfetch-assets failed:', err.message);
  process.exit(1);
});
