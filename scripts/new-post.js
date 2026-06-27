#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { nowInChinaIso } from "./lib/date.js";
import { projectRoot } from "./lib/r2.js";

const BLOG_DIR = resolve(projectRoot, "src/data/blog");

const args = parseArgs(process.argv.slice(2));
const title = args.title || args._[0];

if (!title) {
  console.error("Usage: node scripts/new-post.js \"文章标题\" [--slug custom-slug] [--tags ai,tech] [--publish]");
  process.exit(1);
}

const slug = args.slug || slugifyFileName(title);
const filePath = resolve(BLOG_DIR, `${slug}.md`);
const tags = normalizeTags(args.tags || "");
const publish = Boolean(args.publish);
const publicTags = tags.filter(tag => tag !== "draft" && tag !== "release");
const finalTags = publish ? ["release", ...publicTags] : ["draft", ...publicTags];
const pubDatetime = publish ? nowInChinaIso() : "1970-01-01T00:00:00+08:00";
const description = args.description || "TODO: 用一句话说明这篇文章解决什么问题。";

if (existsSync(filePath)) {
  console.error(`Post already exists: ${filePath}`);
  process.exit(1);
}

mkdirSync(BLOG_DIR, { recursive: true });

const content = `---
title: ${JSON.stringify(title)}
author: F3D
pubDatetime: ${pubDatetime}
description: ${JSON.stringify(description)}
tags:
${finalTags.map(tag => `  - ${tag}`).join("\n")}
---

## 写作简报

> 面向 AI agent：这一节用于承接用户思路，成文前请删除。

- 核心观点：
- 读者是谁：
- 为什么现在写：
- 必须保留的例子/经历：
- 不要写成：

## 正文

TODO
`;

writeFileSync(filePath, content);
console.log(`Created ${filePath}`);
console.log(`Slug: ${basename(filePath, ".md")}`);

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }

    const key = arg.slice(2);
    if (key === "publish") {
      parsed.publish = true;
      continue;
    }

    parsed[key] = argv[++i];
  }
  return parsed;
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map(tag => tag.trim())
    .filter(Boolean);
}

function slugifyFileName(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
