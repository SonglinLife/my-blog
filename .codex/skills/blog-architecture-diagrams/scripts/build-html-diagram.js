#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";

const [input, output] = process.argv.slice(2);

if (!input || !output || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.error("Usage: node build-html-diagram.js <diagram.html> <built.html>");
  process.exit(input || output ? 0 : 1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "..");
const kitPath = path.resolve(skillRoot, "assets", "diagram-kit.css");
const inputPath = path.resolve(input);
const outputPath = path.resolve(output);

const html = fs.readFileSync(inputPath, "utf8");
const kitCss = fs.readFileSync(kitPath, "utf8");
const localCss = collectLocalDiagramCss(html);
const classNames = collectClassNames(html);
const safelist = Array.from(classNames).sort().join(" ");

const sourceCss = `${kitCss}\n@source inline("${escapeForInlineSource(safelist)}");\n${localCss}`;
const compiled = await compile(sourceCss, {
  base: skillRoot,
  onDependency() {},
});

const css = compiled.build(Array.from(classNames));
const nextHtml = inlineCss(html, css);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, nextHtml);
console.log(`Wrote ${outputPath}`);

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
