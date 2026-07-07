#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const files = process.argv.slice(2);

if (!files.length || files.includes("--help") || files.includes("-h")) {
  console.error("Usage: node validate-html-diagram.js <diagram.html> [...]");
  process.exit(files.length ? 0 : 1);
}

let failed = false;

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const issues = [];
  const dir = path.dirname(path.resolve(file));

  function issue(level, message) {
    issues.push({ level, message });
  }

  if (!/<main\b[^>]*\bdata-diagram-root\b/i.test(source)) {
    issue("error", "missing <main data-diagram-root> fixed canvas root");
  }

  if (!/\baria-label=["'][^"']{24,}["']/i.test(source)) {
    issue("error", "diagram root needs a meaningful aria-label");
  }

  const width = source.match(/\bdata-width=["'](\d+)["']/i)?.[1];
  const height = source.match(/\bdata-height=["'](\d+)["']/i)?.[1];
  if (!width || !height) {
    issue("error", "diagram root should declare data-width and data-height");
  } else {
    const w = Number(width);
    const h = Number(height);
    if (w < 1200 || h < 650) issue("warn", `canvas ${w}x${h} may be too small for mobile-readable systems diagrams`);
  }

  if (/@import\s+["']?https?:\/\//i.test(source) || /url\(\s*["']?https?:\/\//i.test(source) || /\b(?:src|href)=["']https?:\/\//i.test(source) || /\b(?:src|href)=["']\/\/cdn\./i.test(source)) {
    issue("error", "remote CSS/JS/image/font dependency found; keep diagram sources self-contained");
  }

  if (/(\/root\/|\/Users\/|[A-Za-z]:\\)/.test(source)) {
    issue("error", "private local path found in diagram source");
  }

  if (/<script\b/i.test(source)) {
    issue("warn", "script tag found; prefer static HTML/CSS plus inline SVG overlays for reproducible diagrams");
  }

  if (!/\.zone\b/.test(source) && !/\bdg-zone\b/.test(source)) {
    issue("warn", "no .zone class found; ownership/layer boundaries may be unclear");
  }

  if (!/\.node\b/.test(source) && !/\bdg-node\b/.test(source)) {
    issue("warn", "no .node class found; concrete components may be missing");
  }

  // Anchored-arrow declarations: data-from/data-to must reference real ids.
  const ids = new Set();
  for (const match of source.matchAll(/\bid=["']([^"']+)["']/gi)) ids.add(match[1]);
  const arrowSpecs = Array.from(source.matchAll(/<[^>]*\bclass=["'][^"']*\bdg-arrow\b[^"']*["'][^>]*>/gi));
  for (const [tag] of arrowSpecs) {
    const from = tag.match(/\bdata-from=["']([^"']+)["']/i)?.[1];
    const to = tag.match(/\bdata-to=["']([^"']+)["']/i)?.[1];
    if (!from || !to) {
      issue("error", "dg-arrow declaration is missing data-from or data-to");
      continue;
    }
    for (const ref of [from, to]) {
      if (!ids.has(ref)) issue("error", `dg-arrow references unknown element id: ${ref}`);
    }
  }

  const handWrittenArrowSvg = /<svg\b[^>]*class=["'][^"']*\b(?:dg-)?arrows\b[^"']*["'][^>]*>[\s\S]*?<path/i.test(source);
  if (handWrittenArrowSvg) {
    issue(
      "warn",
      "hand-written SVG arrow paths found; prefer anchored <div class=\"dg-arrow\" data-from data-to> declarations so routes come from real element positions"
    );
  }
  if (!arrowSpecs.length && !handWrittenArrowSvg && /class=["'][^"']*\bdg-step\b/i.test(source)) {
    issue("warn", "step markers exist but no arrows (dg-arrow declarations or SVG overlay) were found");
  }

  const stepCount =
    (source.match(/\bdata-step=["']/gi) || []).length +
    (source.match(/class=["'][^"']*\bdg-step\b/gi) || []).length;
  if (stepCount > 7) {
    issue("warn", `${stepCount} numbered steps; readers rarely follow more than 7 - split phases or split the diagram`);
  }

  const absoluteSteps = (source.match(/class=["'][^"']*\bdg-step\b[^"']*["'][^>]*\bstyle=["'][^"']*left\s*:/gi) || []).length;
  if (absoluteSteps) {
    issue(
      "warn",
      `${absoluteSteps} step circle(s) positioned with hand-written pixel coordinates; prefer data-step on a dg-arrow declaration`
    );
  }

  for (const match of source.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
    const target = match[1];
    if (/^(#|data:|mailto:)/i.test(target)) continue;
    if (/^https?:\/\//i.test(target)) continue;
    if (target.startsWith("/")) {
      issue("error", `absolute asset path is not portable: ${target}`);
      continue;
    }
    const clean = target.split(/[?#]/)[0];
    if (clean && !fs.existsSync(path.resolve(dir, clean))) {
      issue("warn", `referenced local asset does not exist beside diagram: ${target}`);
    }
  }

  if (issues.length) {
    console.error(`\n${file}`);
    for (const item of issues) {
      console.error(`  [${item.level}] ${item.message}`);
    }
  } else {
    console.log(`${file}: HTML diagram checks passed`);
  }

  if (issues.some((item) => item.level === "error")) failed = true;
}

process.exit(failed ? 1 : 0);
