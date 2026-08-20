#!/usr/bin/env node
/**
 * setup-ocr.js
 * Copies Tesseract.js files from node_modules to lib/tesseract/
 * for use in the Chrome extension (web-accessible resources).
 *
 * Usage:
 *   npm install
 *   npm run setup-ocr
 */

const fs = require("fs");
const path = require("path");

const TESSERACT_SRC = path.join(__dirname, "..", "node_modules", "tesseract.js");
const TESSERACT_DST = path.join(__dirname, "..", "lib", "tesseract");

// Files to copy (relative to node_modules/tesseract.js/dist)
const FILES_TO_COPY = [
  { src: "dist/tesseract.min.js", dst: "tesseract.min.js" },
  { src: "dist/worker.min.js", dst: "worker.min.js" },
  // WASM core files — Tesseract.js v5 uses these
  { src: "dist/tesseract-core-simd.wasm.js", dst: "tesseract-core-simd.wasm.js" },
  { src: "dist/tesseract-core-simd-lstm.wasm.js", dst: "tesseract-core-simd-lstm.wasm.js" },
  { src: "dist/tesseract-core.wasm.js", dst: "tesseract-core.wasm.js" },
  { src: "dist/tesseract-core-lstm.wasm.js", dst: "tesseract-core-lstm.wasm.js" },
];

// Also copy lang training data for Japanese and Korean
const LANG_FILES = [
  { src: "traineddata/jpn.traineddata", dst: "traineddata/jpn.traineddata" },
  { src: "traineddata/jpn_vert.traineddata", dst: "traineddata/jpn_vert.traineddata" },
  { src: "traineddata/kor.traineddata", dst: "traineddata/kor.traineddata" },
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src, dst) {
  const srcPath = path.join(TESSERACT_SRC, src);
  const dstPath = path.join(TESSERACT_DST, dst);

  if (!fs.existsSync(srcPath)) {
    console.warn(`  ⚠ Not found, skipping: ${src}`);
    return false;
  }

  ensureDir(path.dirname(dstPath));
  fs.copyFileSync(srcPath, dstPath);
  console.log(`  ✓ Copied: ${src} → ${dst}`);
  return true;
}

// Main
console.log("Setting up Tesseract.js for Rikai...\n");

// Check if tesseract.js is installed
if (!fs.existsSync(TESSERACT_SRC)) {
  console.error("❌ tesseract.js not found in node_modules.");
  console.error("   Run: npm install");
  process.exit(1);
}

// Get version info
const pkg = JSON.parse(
  fs.readFileSync(path.join(TESSERACT_SRC, "package.json"), "utf8")
);
console.log(`Tesseract.js version: ${pkg.version}\n`);

// Create destination directory
ensureDir(TESSERACT_DST);

// Copy main files
console.log("Copying core files:");
let copied = 0;
for (const file of FILES_TO_COPY) {
  if (copyFile(file.src, file.dst)) copied++;
}

// Copy training data (these may not be in the npm package — they're downloaded at runtime)
console.log("\nCopying training data:");
for (const file of LANG_FILES) {
  copyFile(file.src, file.dst);
}

// Check what we have
console.log("\nResult:");
const files = [];
function listDir(dir, prefix = "") {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      listDir(path.join(dir, entry.name), prefix + entry.name + "/");
    } else {
      const stat = fs.statSync(path.join(dir, entry.name));
      files.push(`${prefix}${entry.name} (${(stat.size / 1024).toFixed(1)} KB)`);
    }
  }
}
listDir(TESSERACT_DST);

if (files.length > 0) {
  console.log(`Files in lib/tesseract/:`);
  for (const f of files) {
    console.log(`  ${f}`);
  }
} else {
  console.log("  (no files copied)");
}

console.log("\n✅ Setup complete.");
console.log("\nNote: Tesseract.js v5 downloads traineddata files at runtime from CDN.");
console.log("For offline use, you may need to manually download them.");
console.log("See: https://github.com/naptha/tesseract.js/blob/main/docs/training-data.md");
