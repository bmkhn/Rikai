#!/usr/bin/env node
/**
 * download-traineddata.js
 * Downloads Tesseract trained data files for Japanese and Korean.
 *
 * Usage: node scripts/download-traineddata.js
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const DEST_DIR = path.join(__dirname, "..", "lib", "tesseract", "traineddata");

const FILES = [
  {
    name: "jpn.traineddata",
    url: "https://cdn.jsdelivr.net/npm/tesseract.js-data@5/jpn.traineddata",
  },
  {
    name: "kor.traineddata",
    url: "https://cdn.jsdelivr.net/npm/tesseract.js-data@5/kor.traineddata",
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`  Downloading: ${url}`);

    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          return download(response.headers.location, dest).then(resolve).catch(reject);
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        }

        const totalBytes = parseInt(response.headers["content-length"], 10);
        let downloaded = 0;

        response.on("data", (chunk) => {
          downloaded += chunk.length;
          if (totalBytes) {
            const pct = ((downloaded / totalBytes) * 100).toFixed(0);
            process.stdout.write(`\r  ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
          }
        });

        response.pipe(file);

        file.on("finish", () => {
          file.close();
          console.log(`\n  ✓ Saved: ${dest} (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
          resolve();
        });
      })
      .on("error", (err) => {
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        reject(err);
      });
  });
}

async function main() {
  console.log("Downloading Tesseract trained data...\n");

  if (!fs.existsSync(DEST_DIR)) {
    fs.mkdirSync(DEST_DIR, { recursive: true });
  }

  for (const file of FILES) {
    const dest = path.join(DEST_DIR, file.name);

    // Skip if already exists
    if (fs.existsSync(dest)) {
      const stat = fs.statSync(dest);
      if (stat.size > 1000000) {
        // > 1MB = likely valid
        console.log(`  ⏭ Already exists: ${file.name} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
        continue;
      }
    }

    try {
      await download(file.url, dest);
    } catch (err) {
      console.error(`  ❌ Failed to download ${file.name}: ${err.message}`);
    }
  }

  console.log("\nDone!");
}

main();
