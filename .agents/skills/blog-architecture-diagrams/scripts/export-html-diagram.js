#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildDiagramHtml } from "./build-html-diagram.js";

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const positional = argv.filter((a) => !a.startsWith("--"));
const [input, output] = positional;

if (!input || !output || argv.includes("--help") || argv.includes("-h")) {
  console.error("Usage: node export-html-diagram.js <diagram.html> <output.png> [--force]");
  console.error("  --force  export the PNG even when the geometry audit reports errors");
  process.exit(input || output ? 0 : 1);
}

const inputPath = path.resolve(input);
const outputPath = path.resolve(output);

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

const browser = findBrowser();
const builtPath = inputPath.replace(/\.diagram\.html$/i, ".built.html");
const liveHtml = await buildDiagramHtml(inputPath, { inlineRuntime: true });
fs.writeFileSync(builtPath, liveHtml);

if (!browser) {
  console.error(
    "No Chrome/Chromium executable found. The built HTML still renders arrows in any browser:"
  );
  console.error(`  open ${builtPath}`);
  console.error("Capture the fixed-size diagram canvas manually, then inspect the image.");
  process.exit(2);
}

const width = Number(liveHtml.match(/\bdata-width=["'](\d+)["']/i)?.[1] ?? 1800);
const height = Number(liveHtml.match(/\bdata-height=["'](\d+)["']/i)?.[1] ?? 1000);

// Pass 1: execute the arrow runtime in headless Chrome and capture the DOM
// with arrows, label chips, and the geometry report baked in.
const dumped = await runChrome(browser, ["--dump-dom", pathToFileURL(builtPath).href], {
  capture: true,
  width,
  height,
});

if (!dumped || !dumped.includes("data-dg-done")) {
  console.error("Arrow runtime did not finish in headless Chrome; inspect the built HTML manually.");
  process.exit(1);
}

const report = extractReport(dumped);
const errors = report.filter((r) => r.level === "error");
const warns = report.filter((r) => r.level !== "error");

for (const item of report) {
  console.error(`  [${item.level}] ${item.message}`);
}

// Bake a fully static built.html: computed arrows stay, runtime and report go.
let staticHtml = dumped
  .replace(/<script\b[^>]*data-diagram-arrows[^>]*>[\s\S]*?<\/script>\s*/gi, "")
  .replace(/<script\b[^>]*data-dg-report[^>]*>[\s\S]*?<\/script>\s*/gi, "");
if (!/^\s*<!doctype/i.test(staticHtml)) staticHtml = `<!doctype html>\n${staticHtml}`;
fs.writeFileSync(builtPath, staticHtml);

if (errors.length && !force) {
  console.error(
    `\nGeometry audit failed with ${errors.length} error(s); PNG not exported. Fix the source (anchors, data-mid, data-lane, layout) and rerun, or pass --force to override.`
  );
  process.exit(3);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

// Pass 2: screenshot the static baked HTML.
const shot = await runChrome(
  browser,
  [`--screenshot=${outputPath}`, pathToFileURL(builtPath).href],
  { capture: false, width, height, artifact: outputPath }
);
if (shot === null) {
  console.error("Browser screenshot failed");
  process.exit(1);
}

console.log(`Wrote ${outputPath}`);
if (warns.length) console.log(`${warns.length} geometry warning(s) above - review them in the PNG.`);
console.log("Now visually inspect the exported image (Read the PNG) before embedding it in the post.");

/*
 * Run headless Chrome and wait for its ARTIFACT, not its exit. Chrome 149+
 * "new headless" hangs at shutdown when page JS forced layout (any
 * getBoundingClientRect call) before --dump-dom / --screenshot, but it always
 * writes the output first. So: spawn, poll until the artifact is complete,
 * then SIGKILL the process tree ourselves.
 */
async function runChrome(executable, extraArgs, { capture, width, height, artifact }) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-chrome-"));
  const stdoutFile = capture ? path.join(userDataDir, "dump.out") : null;
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    ...extraArgs,
  ];

  const stdoutFd = stdoutFile ? fs.openSync(stdoutFile, "w") : "ignore";
  const child = spawn(executable, args, { stdio: ["ignore", stdoutFd, "ignore"] });
  if (stdoutFile) fs.closeSync(stdoutFd);

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + 60_000;
  const artifactPath = capture ? stdoutFile : artifact;
  let lastSize = -1;
  let done = false;
  while (Date.now() < deadline) {
    await sleep(250);
    let size = 0;
    try {
      size = fs.statSync(artifactPath).size;
    } catch {
      size = 0;
    }
    if (capture) {
      // The DOM dump is complete once the serialized document is closed.
      if (size > 0 && /<\/html>\s*$/i.test(fs.readFileSync(artifactPath, "utf8"))) {
        done = true;
        break;
      }
    } else if (size > 1000 && size === lastSize) {
      // Screenshot is complete once the PNG exists and its size is stable.
      done = true;
      break;
    }
    lastSize = size;
    if (exited) {
      done = size > 0;
      break;
    }
  }

  if (!exited) {
    child.kill("SIGKILL");
    await sleep(120);
  }
  const output = capture && done ? fs.readFileSync(artifactPath, "utf8") : "";
  fs.rmSync(userDataDir, { recursive: true, force: true });
  if (!done) {
    console.error("Chrome produced no complete output within 60s.");
    return null;
  }
  return capture ? output : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractReport(html) {
  // The runtime source itself can mention the marker, so take the last match:
  // the real report tag is appended to the end of <body>.
  const matches = Array.from(
    html.matchAll(/<script\b[^>]*data-dg-report[^>]*>([\s\S]*?)<\/script>/gi)
  );
  if (!matches.length) return [];
  try {
    const parsed = JSON.parse(decodeEntities(matches[matches.length - 1][1].trim()));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [{ level: "warn", message: "geometry report could not be parsed" }];
  }
}

function decodeEntities(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
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
    const found = spawnSync("sh", ["-lc", `command -v ${shellQuote(candidate)}`], {
      encoding: "utf8",
    });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
