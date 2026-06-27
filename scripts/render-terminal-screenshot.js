#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import sharp from "sharp";

const [inputPath, outputPath, title = basename(inputPath)] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error("Usage: node scripts/render-terminal-screenshot.js <input.txt> <output.png> [title]");
  process.exit(1);
}

const text = readFileSync(inputPath, "utf8").replace(/\s+$/u, "");
const lines = text.split("\n");
const fontSize = 22;
const lineHeight = 33;
const paddingX = 34;
const paddingBottom = 30;
const chromeHeight = 58;
const maxLineChars = Math.max(...lines.map(line => visualLength(line)), title.length);
const width = Math.min(1500, Math.max(920, paddingX * 2 + maxLineChars * 13));
const height = chromeHeight + paddingBottom + Math.max(1, lines.length) * lineHeight;

const body = lines
  .map((line, index) => {
    const y = chromeHeight + 34 + index * lineHeight;
    return `<text x="${paddingX}" y="${y}" class="terminal-text">${escapeXml(line)}</text>`;
  })
  .join("\n");

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" rx="16" fill="#101418"/>
  <rect width="100%" height="${chromeHeight}" rx="16" fill="#19212a"/>
  <circle cx="30" cy="29" r="7" fill="#ff5f57"/>
  <circle cx="54" cy="29" r="7" fill="#ffbd2e"/>
  <circle cx="78" cy="29" r="7" fill="#28c840"/>
  <text x="112" y="37" class="title">${escapeXml(title)}</text>
  <style>
    .title {
      fill: #b9c2cf;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 17px;
      font-weight: 600;
    }
    .terminal-text {
      fill: #e6edf3;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: ${fontSize}px;
      white-space: pre;
    }
  </style>
  ${body}
</svg>`;

mkdirSync(dirname(resolve(outputPath)), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(outputPath);

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function visualLength(value) {
  let length = 0;
  for (const char of value) {
    length += char.codePointAt(0) > 127 ? 2 : 1;
  }
  return length;
}
