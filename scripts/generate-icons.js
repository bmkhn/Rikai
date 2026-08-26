#!/usr/bin/env node
/**
 * generate-icons.js
 * Generates Rikai extension icons: blue hiragana "り" on transparent background.
 *
 * Usage: node scripts/generate-icons.js
 */

const { createCanvas } = require("canvas");
const fs = require("fs");
const path = require("path");

const ICONS_DIR = path.join(__dirname, "..", "icons");
const SIZES = [16, 48, 128];

// Match the Mihon-style blue from the reference image
const CHAR_COLOR = "#1565C0"; // deep blue
const SHADOW_COLOR = "rgba(0, 0, 0, 0.15)";

if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

for (const size of SIZES) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // White background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);

  // Font size — fill most of the icon
  const fontSize = Math.round(size * 0.78);
  const font = `bold ${fontSize}px "Yu Gothic", "Meiryo", "Hiragino Sans", sans-serif`;

  // Subtle drop shadow for depth
  ctx.shadowColor = SHADOW_COLOR;
  ctx.shadowBlur = Math.max(1, Math.round(size * 0.04));
  ctx.shadowOffsetX = Math.round(size * 0.02);
  ctx.shadowOffsetY = Math.round(size * 0.03);

  ctx.fillStyle = CHAR_COLOR;
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Slight vertical offset to optically center the character
  const offsetY = Math.round(size * 0.02);
  ctx.fillText("り", size / 2, size / 2 + offsetY);

  const buf = canvas.toBuffer("image/png");
  const filePath = path.join(ICONS_DIR, `icon${size}.png`);
  fs.writeFileSync(filePath, buf);
  console.log(`Created ${filePath} (${buf.length} bytes)`);
}

console.log("Done! Icons generated.");
