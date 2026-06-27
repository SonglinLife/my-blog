#!/usr/bin/env node
import { resolve } from "node:path";
import { rewriteLocalImages } from "./lib/images.js";
import { projectRoot } from "./lib/r2.js";

const args = parseArgs(process.argv.slice(2));
const file = args._[0];

if (!file) {
  console.error("Usage: node scripts/upload-post-images.js src/data/blog/post.md [--dry-run]");
  process.exit(1);
}

const filePath = resolve(projectRoot, file);
const results = await rewriteLocalImages(filePath, { dryRun: args.dryRun });

if (results.length === 0) {
  console.log("No local images found.");
  process.exit(0);
}

for (const result of results) {
  console.log(`${result.from} -> ${result.to}`);
}

function parseArgs(argv) {
  const parsed = { _: [], dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else {
      parsed._.push(arg);
    }
  }
  return parsed;
}
