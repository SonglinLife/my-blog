#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import kebabcase from "lodash.kebabcase";
import slugify from "slugify";
import {
  getBoolean,
  getScalar,
  getTags,
  parseMarkdownFile,
} from "./lib/frontmatter.js";
import { collectImageRefs, isRemoteImage } from "./lib/images.js";
import { projectRoot } from "./lib/r2.js";

const BLOG_DIR = resolve(projectRoot, "src/data/blog");
const allowedInternalSections = new Set(["写作简报"]);
const reservedTags = new Set(["release", "draft"]);

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const files = process.argv
  .slice(2)
  .filter(arg => !arg.startsWith("--"))
  .map(file => resolve(projectRoot, file));
const targets = files.length > 0 ? files : listMarkdownFiles(BLOG_DIR);
const allPosts = listMarkdownFiles(BLOG_DIR);

const findings = [];

checkUniqueContentIds(allPosts);

for (const filePath of targets) {
  checkPost(filePath);
}

if (findings.length > 0) {
  for (const item of findings) {
    console.error(`${item.level.toUpperCase()} ${item.file}: ${item.message}`);
  }
}

const hasErrors = findings.some(item => item.level === "error");
const hasWarnings = findings.some(item => item.level === "warn");
if (hasErrors || (strict && hasWarnings)) process.exit(1);

console.log(`Checked ${targets.length} post(s).`);

function checkPost(filePath) {
  const rel = relativeFile(filePath);
  const { frontmatter, body, hasFrontmatter } = parseMarkdownFile(filePath);

  if (!hasFrontmatter) {
    add("error", rel, "missing YAML frontmatter");
    return;
  }

  const title = getScalar(frontmatter, "title");
  const description = getScalar(frontmatter, "description");
  const pubDatetime = getScalar(frontmatter, "pubDatetime");
  const draft = getBoolean(frontmatter, "draft");
  const tags = getTags(frontmatter);
  const released = tags.includes("release");

  if (!title) add("error", rel, "frontmatter.title is required");
  if (!description) add("error", rel, "frontmatter.description is required");
  if (description && description.length > 120) {
    add("warn", rel, "description should be <= 120 characters");
  }
  if (!pubDatetime) add("error", rel, "frontmatter.pubDatetime is required");
  if (released && pubDatetime.startsWith("1970")) {
    add("error", rel, "released posts cannot keep placeholder pubDatetime");
  }
  if (released && draft === true) {
    add("error", rel, "released posts cannot have draft: true");
  }
  if (released && tags.includes("draft")) {
    add("error", rel, "released posts cannot keep draft tag");
  }
  if (!released && !tags.includes("draft")) {
    add("warn", rel, "unreleased posts should include draft tag");
  }
  if (tags.length === 0) add("error", rel, "at least one tag is required");

  const publicTags = tags.filter(tag => !reservedTags.has(tag));
  if (released && publicTags.length === 0) {
    add("error", rel, "released posts need at least one public tag besides release");
  }

  if (/TODO|待补|写作简报/.test(body) && released) {
    add("error", rel, "released post still contains TODO/internal drafting notes");
  }

  for (const section of allowedInternalSections) {
    if (new RegExp(`^##\\s+${section}`, "m").test(body) && released) {
      add("error", rel, `released post still contains internal section: ${section}`);
    }
  }

  const imageRefs = collectImageRefs(body, filePath);
  for (const ref of imageRefs) {
    if (isRemoteImage(ref.url)) continue;
    if (!ref.resolvedPath || !existsSync(ref.resolvedPath)) {
      add("error", rel, `image not found: ${ref.url}`);
      continue;
    }
    if (released) {
      add("error", rel, `released post uses local image, run image upload first: ${ref.url}`);
    }
  }
}

function listMarkdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(fullPath);
    if (entry.isFile() && extname(entry.name) === ".md") return [fullPath];
    return [];
  });
}

function checkUniqueContentIds(filePaths) {
  const byId = new Map();

  for (const filePath of filePaths) {
    const id = contentIdFor(filePath);
    const existing = byId.get(id);

    if (!existing) {
      byId.set(id, filePath);
      continue;
    }

    add(
      "error",
      relativeFile(filePath),
      `duplicate content id "${id}" also used by ${relativeFile(existing)}`
    );
  }
}

function contentIdFor(filePath) {
  const relativePath = relative(BLOG_DIR, filePath);
  const withoutExt = relativePath.slice(0, -extname(relativePath).length);

  return withoutExt
    .split("/")
    .filter(Boolean)
    .filter(segment => !segment.startsWith("_"))
    .map(slugifyStr)
    .join("/");
}

function slugifyStr(value) {
  if (/[^\u0000-\u007F]/.test(value)) {
    return kebabcase(value);
  }

  return slugify(value, { lower: true });
}

function add(level, file, message) {
  findings.push({ level, file, message });
}

function relativeFile(filePath) {
  return filePath.replace(`${projectRoot}/`, "");
}
