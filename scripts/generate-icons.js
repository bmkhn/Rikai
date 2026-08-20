#!/usr/bin/env node
/**
 * generate-icons.js
 * Generates placeholder PNG icons for the Rikai extension.
 * Uses only Node.js built-in modules (no dependencies).
 *
 * Usage: node scripts/generate-icons.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ICONS_DIR = path.join(__dirname, "..", "icons");

// Icon sizes to generate
const SIZES = [16, 48, 128];

// Colors (RGB)
const BG_COLOR = { r: 0x1a, g: 0x1a, b: 0x2e }; // dark blue
const FG_COLOR = { r: 0xe9, g: 0x45, b: 0x60 }; // accent red/pink

/**
 * Create a minimal valid PNG buffer for a solid color square.
 */
function createPNG(size, bgColor, fgColor) {
  // We'll create a simple PNG with:
  // - A solid background
  // - A centered "R" letter approximation (or just a colored circle/square for now)

  const width = size;
  const height = size;

  // Build raw image data (RGBA, filter byte per row)
  const rawData = [];

  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter: None

    for (let x = 0; x < width; x++) {
      // Check if pixel is inside a centered rounded square / circle
      const cx = width / 2;
      const cy = height / 2;
      const radius = width / 2 - 1;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < radius * 0.85) {
        // Inner circle - use foreground color
        rawData.push(fgColor.r, fgColor.g, fgColor.b, 255);
      } else if (dist < radius) {
        // Edge - slightly darker
        rawData.push(
          Math.floor(fgColor.r * 0.7),
          Math.floor(fgColor.g * 0.7),
          Math.floor(fgColor.b * 0.7),
          255
        );
      } else {
        // Background - transparent
        rawData.push(0, 0, 0, 0);
      }
    }
  }

  const rawBuffer = Buffer.from(rawData);

  // Compress with deflate
  const compressed = zlib.deflateSync(rawBuffer);

  // Build PNG
  const chunks = [];

  // Signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(makeChunk("IHDR", ihdr));

  // IDAT chunk
  chunks.push(makeChunk("IDAT", compressed));

  // IEND chunk
  chunks.push(makeChunk("IEND", Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, "ascii");
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

// CRC32 lookup table
let crcTable;
function makeCrcTable() {
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c;
  }
}

function crc32(buf) {
  if (!crcTable) makeCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Generate icons
if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

for (const size of SIZES) {
  const png = createPNG(size, BG_COLOR, FG_COLOR);
  const filePath = path.join(ICONS_DIR, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created ${filePath} (${png.length} bytes)`);
}

console.log("Done! Icons generated.");
