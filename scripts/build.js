#!/usr/bin/env node
/**
 * build.js — Rikai build step.
 *
 * Bundles the offscreen-document OCR engine (Transformers.js + MangaOCR)
 * into a self-contained ES module under dist/, and copies the ONNX Runtime
 * WASM binaries next to it so the extension never loads remote code.
 *
 * Usage:
 *   npm run build          # one-shot
 *   npm run build:watch    # rebuild on change
 */

const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const ENTRY = path.join(ROOT, "offscreen", "offscreen-ocr-src.js");
const OUTFILE = path.join(DIST, "offscreen-ocr.js");

// ONNX Runtime Web binaries shipped by @huggingface/transformers.
// These must live at extension URLs (referenced via chrome.runtime.getURL
// from offscreen-ocr-src.js through env.backends.onnx.wasm.wasmPaths).
const ORT_DIST = path.join(
  ROOT,
  "node_modules",
  "@huggingface",
  "transformers",
  "dist"
);
const ORT_ASSETS = [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
];

const watch = process.argv.includes("--watch");

function copyOrtAssets() {
  for (const asset of ORT_ASSETS) {
    const src = path.join(ORT_DIST, asset);
    const dst = path.join(DIST, asset);
    if (!fs.existsSync(src)) {
      console.warn(`  ⚠ Missing ORT asset (skipping): ${asset}`);
      continue;
    }
    fs.copyFileSync(src, dst);
    const mb = (fs.statSync(dst).size / 1024 / 1024).toFixed(1);
    console.log(`  ✓ ${asset} (${mb} MB)`);
  }
}

async function main() {
  fs.mkdirSync(DIST, { recursive: true });

  /** @type {import('esbuild').BuildOptions} */
  const options = {
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    format: "esm",
    target: ["chrome116"],
    platform: "browser",
    sourcemap: false,
    minify: true,
    logLevel: "info",
    // Everything must be bundled — the extension may not fetch remote code.
    external: [],
  };

  if (watch) {
    const ctx = await esbuild.context(options);
    copyOrtAssets();
    await ctx.watch();
    console.log("[Rikai] Watching for changes...");
  } else {
    await esbuild.build(options);
    copyOrtAssets();
    console.log("[Rikai] Build complete.");
  }
}

main().catch((err) => {
  console.error("[Rikai] Build failed:", err);
  process.exit(1);
});
