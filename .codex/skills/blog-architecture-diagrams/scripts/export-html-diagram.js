#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "@tailwindcss/node";

const [input, output] = process.argv.slice(2);

if (!input || !output || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.error("Usage: node export-html-diagram.js <diagram.html> <output.png>");
  process.exit(input || output ? 0 : 1);
}

const inputPath = path.resolve(input);
const outputPath = path.resolve(output);

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

const browserInputPath = await ensureBuiltHtml(inputPath);
const source = fs.readFileSync(browserInputPath, "utf8");
const width = Number(source.match(/\bdata-width=["'](\d+)["']/i)?.[1] ?? 1800);
const height = Number(source.match(/\bdata-height=["'](\d+)["']/i)?.[1] ?? 1000);
const browser = findBrowser();

if (!browser) {
  console.error("No Chrome/Chromium executable found. Open the HTML file in a browser and capture the fixed-size diagram canvas manually.");
  process.exit(2);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-chrome-"));
const args = [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-sandbox",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${userDataDir}`,
  `--window-size=${width},${height}`,
  `--screenshot=${outputPath}`,
  pathToFileURL(browserInputPath).href,
];

const result = spawnSync(browser, args, { stdio: "inherit" });
fs.rmSync(userDataDir, { recursive: true, force: true });

if (result.status !== 0) {
  console.error(`Browser export failed with exit code ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log(`Wrote ${outputPath}`);

async function ensureBuiltHtml(file) {
  const html = fs.readFileSync(file, "utf8");
  if (!/<link\b[^>]*data-diagram-kit\b/i.test(html) && !/<style\b[^>]*data-diagram-css\b/i.test(html)) {
    return file;
  }

  const builtPath = file.replace(/\.diagram\.html$/i, ".built.html");
  const kitPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "diagram-kit.css");
  const kitCss = fs.readFileSync(kitPath, "utf8");
  const localCss = collectLocalDiagramCss(html);
  const classNames = collectClassNames(html);
  const sourceCss = `${kitCss}\n@source inline("${escapeForInlineSource(Array.from(classNames).sort().join(" "))}");\n${localCss}`;
  const compiled = await compile(sourceCss, {
    base: path.dirname(kitPath),
    onDependency() {},
  });
  const css = compiled.build(Array.from(classNames));
  fs.writeFileSync(builtPath, inlineCss(html, css));
  return builtPath;
}

function findBrowser() {
  const env = process.env.CHROME_PATH || process.env.CHROMIUM_PATH;
  const candidates = [
    env,
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && fs.existsSync(candidate)) return candidate;
    const found = spawnSync("sh", ["-lc", `command -v ${shellQuote(candidate)}`], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function collectClassNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/\bclass=["']([^"']+)["']/gi)) {
    for (const name of match[1].trim().split(/\s+/)) {
      if (name) names.add(name);
    }
  }
  return names;
}

function collectLocalDiagramCss(source) {
  const chunks = [];
  for (const match of source.matchAll(/<style\b[^>]*data-diagram-css[^>]*>([\s\S]*?)<\/style>/gi)) {
    chunks.push(match[1]);
  }
  return chunks.join("\n");
}

function inlineCss(source, css) {
  let next = source
    .replace(/<link\b[^>]*data-diagram-kit[^>]*>\s*/gi, "")
    .replace(/<style\b[^>]*data-diagram-css[^>]*>[\s\S]*?<\/style>\s*/gi, "");
  const style = `<style data-diagram-built>\n${css}\n</style>`;
  if (/<style\b[^>]*data-diagram-built[^>]*>[\s\S]*?<\/style>/i.test(next)) {
    return next.replace(/<style\b[^>]*data-diagram-built[^>]*>[\s\S]*?<\/style>/i, style);
  }
  return next.replace("</head>", `${style}\n  </head>`);
}

function escapeForInlineSource(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
