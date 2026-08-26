#!/usr/bin/env node
/**
 * build.js — Rikai build step.
 *
 * Compiles TypeScript source files to JavaScript and bundles the offscreen
 * OCR engine. All compiled output goes to dist/ so the extension loads
 * only production JS.
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

// ONNX Runtime Web binaries shipped by @huggingface/transformers.
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

/** @type {import('esbuild').Plugin} */
const copyHtmlPlugin = {
  name: "copy-html",
  setup(build) {
    build.onEnd(() => {
      // Copy offscreen.html — script paths are relative to dist/offscreen/
      const offscreenHtml = fs
        .readFileSync(path.join(ROOT, "offscreen", "offscreen.html"), "utf8")
        .replace('src="../dist/offscreen/text-detector.js"', 'src="text-detector.js"')
        .replace('src="../dist/offscreen/offscreen.js"', 'src="offscreen.js"')
        .replace('src="../dist/offscreen-ocr.js"', 'src="../offscreen-ocr.js"');
      fs.mkdirSync(path.join(DIST, "offscreen"), { recursive: true });
      fs.writeFileSync(path.join(DIST, "offscreen", "offscreen.html"), offscreenHtml);

      // Copy popup files
      const popupHtml = fs
        .readFileSync(path.join(ROOT, "popup", "popup.html"), "utf8")
        .replace('src="popup.js"', 'src="popup.js"');
      fs.mkdirSync(path.join(DIST, "popup"), { recursive: true });
      fs.writeFileSync(path.join(DIST, "popup", "popup.html"), popupHtml);
      fs.copyFileSync(
        path.join(ROOT, "popup", "popup.css"),
        path.join(DIST, "popup", "popup.css")
      );

      // Copy manifest with updated paths
      const manifest = JSON.parse(
        fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")
      );
      manifest.background.service_worker = "background.js";
      manifest.action.default_popup = "popup/popup.html";
      manifest.content_scripts[0].js = [
        "content/image-extractor.js",
        "content/ocr-pipeline.js",
        "content/translator.js",
        "content/overlay.js",
        "content/content.js",
      ];
      fs.writeFileSync(
        path.join(DIST, "manifest.json"),
        JSON.stringify(manifest, null, 2)
      );

      // Copy icons
      const iconsDir = path.join(ROOT, "icons");
      const distIconsDir = path.join(DIST, "icons");
      if (fs.existsSync(iconsDir)) {
        fs.mkdirSync(distIconsDir, { recursive: true });
        for (const file of fs.readdirSync(iconsDir)) {
          if (file.endsWith(".png")) {
            fs.copyFileSync(path.join(iconsDir, file), path.join(distIconsDir, file));
          }
        }
        console.log("  ✓ Copied icons to dist/");
      }

      console.log("  ✓ Copied HTML, CSS, and manifest to dist/");
    });
  },
};

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

  // ── 1. Bundle offscreen OCR engine (esbuild handles TS + bundling) ──
  /** @type {import('esbuild').BuildOptions} */
  const ocrOptions = {
    entryPoints: [path.join(ROOT, "offscreen", "offscreen-ocr-src.ts")],
    outfile: path.join(DIST, "offscreen-ocr.js"),
    bundle: true,
    format: "esm",
    target: ["chrome116"],
    platform: "browser",
    sourcemap: false,
    minify: true,
    logLevel: "info",
    external: [],
  };

  // ── 2. Compile all TS → JS (individual files, no bundling) ──
  /** @type {import('esbuild').BuildOptions} */
  const tsOptions = {
    entryPoints: [
      path.join(ROOT, "background.ts"),
      path.join(ROOT, "content", "image-extractor.ts"),
      path.join(ROOT, "content", "ocr-pipeline.ts"),
      path.join(ROOT, "content", "translator.ts"),
      path.join(ROOT, "content", "overlay.ts"),
      path.join(ROOT, "content", "content.ts"),
      path.join(ROOT, "offscreen", "offscreen.ts"),
      path.join(ROOT, "offscreen", "text-detector.ts"),
      path.join(ROOT, "popup", "popup.ts"),
    ],
    outdir: DIST,
    outbase: ROOT,
    bundle: false,
    format: "iife",
    target: ["chrome116"],
    platform: "browser",
    sourcemap: false,
    minify: false,
    logLevel: "info",
    plugins: [copyHtmlPlugin],
  };

  if (watch) {
    const [ocrCtx, tsCtx] = await Promise.all([
      esbuild.context(ocrOptions),
      esbuild.context(tsOptions),
    ]);
    copyOrtAssets();
    await Promise.all([ocrCtx.watch(), tsCtx.watch()]);
    console.log("[Rikai] Watching for changes...");
  } else {
    await Promise.all([
      esbuild.build(ocrOptions),
      esbuild.build(tsOptions),
    ]);
    copyOrtAssets();
    console.log("[Rikai] Build complete.");
  }
}

main().catch((err) => {
  console.error("[Rikai] Build failed:", err);
  process.exit(1);
});
