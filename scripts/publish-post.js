#!/usr/bin/env node
import { resolve } from "node:path";
import {
  getScalar,
  getTags,
  parseMarkdownFile,
  setScalar,
  setTags,
  writeMarkdownFile,
} from "./lib/frontmatter.js";
import { nowInChinaIso } from "./lib/date.js";
import { rewriteLocalImages } from "./lib/images.js";
import { projectRoot } from "./lib/r2.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/publish-post.js src/data/blog/post.md");
  process.exit(1);
}

const filePath = resolve(projectRoot, file);
await rewriteLocalImages(filePath);

const parsed = parseMarkdownFile(filePath);
if (!parsed.hasFrontmatter) {
  console.error("Cannot publish: missing frontmatter.");
  process.exit(1);
}

let frontmatter = parsed.frontmatter;
const tags = getTags(frontmatter);
frontmatter = setTags(frontmatter, [
  "release",
  ...tags.filter(tag => tag !== "draft" && tag !== "release"),
]);

const pubDatetime = getScalar(frontmatter, "pubDatetime");
if (!pubDatetime || pubDatetime.startsWith("1970")) {
  frontmatter = setScalar(frontmatter, "pubDatetime", nowInChinaIso());
}

frontmatter = setScalar(frontmatter, "draft", "false");
writeMarkdownFile(filePath, frontmatter, parsed.body);

console.log(`Published metadata updated: ${filePath}`);
