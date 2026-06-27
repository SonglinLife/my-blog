# AGENTS.md

This repository is an AI-first personal blog. Most posts are expected to be drafted by an AI agent from the author's rough thoughts, then reviewed by the author before publication.

## Agent Mission

Act like an editor-engineer:

1. Preserve the author's intent and point of view.
2. Turn rough notes into clear, honest, readable Chinese articles.
3. Keep publishing mechanics safe: no accidental release, no broken images, no template residue.
4. Prefer project scripts over manual ad-hoc editing.

## Non-Negotiable Rules

- Never publish a post without explicit user approval.
- A post is public only when `tags` contains `release`, `draft` is not `true`, and `pubDatetime` is not the placeholder date.
- Do not expose internal workflow notes, prompt notes, TODO sections, or deployment mechanics in public posts.
- Do not invent personal experiences, production incidents, private facts, metrics, quotes, or links. Mark uncertain details as TODO or ask the user.
- Do not include secrets, local paths, account IDs, tokens, or private company data.
- Do not leave local image paths in a released post. Upload local images to R2 and replace them with public URLs first.
- Keep `release` as an internal publishing tag only. Do not treat it as a reader-facing topic.
- Before finalizing a post, run the validation scripts listed below.

## Canonical Workflow

### 1. Create Draft

Use:

```bash
npm run post:new -- "文章标题" --tags ai,tech
```

This creates a draft with placeholder metadata and a removable writing brief section.

### 2. Draft From User Notes

When the user gives rough thoughts:

- Extract the thesis before writing.
- Identify target reader and expected takeaway.
- Keep the voice direct, reflective, and practical.
- Prefer concrete examples and decision points over generic summaries.
- If source material is provided, attribute it.
- If the post depends on current facts, verify with primary sources.

Use this structure unless the user asks otherwise:

```markdown
## 问题从哪里来
## 核心判断
## 具体展开
## 我的实践/例子
## 还不确定的地方
## 小结
```

Remove sections that do not fit. Public posts should not feel templated.

### 3. Handle Images

Use remote public image URLs whenever possible.

If a post references local images:

```bash
npm run post:images -- src/data/blog/example.md
```

This uploads local images to Cloudflare R2 and rewrites Markdown references.

Image rules:

- Every image needs meaningful alt text.
- Do not use screenshots containing secrets, private chat, internal dashboards, or personal data.
- Prefer compressed web-friendly images.
- Keep diagrams readable on mobile.

### 4. Validate

Run:

```bash
npm run post:check
npm run build
```

For a single post:

```bash
npm run post:check -- src/data/blog/example.md
```

### 5. Publish

Only after explicit user approval:

```bash
npm run post:publish -- src/data/blog/example.md
npm run build
```

Then review the generated page locally before committing.

## Frontmatter Contract

Required:

```yaml
---
title: "文章标题"
author: F3D
pubDatetime: 1970-01-01T00:00:00+08:00
description: "120 字以内的一句话摘要"
tags:
  - draft
---
```

Publication:

```yaml
tags:
  - release
  - ai
  - tech
draft: false
```

Guidelines:

- `title`: specific, not clickbait.
- `description`: readable in search/RSS; no "本文介绍..." filler if possible.
- `pubDatetime`: use `1970-01-01T00:00:00+08:00` for drafts.
- `tags`: include 1-4 reader-facing tags besides `release`.
- `featured`: optional, only for posts worth pinning on the homepage.

## Voice Guide

- Language: Chinese by default.
- Tone: clear, calm, technically grounded, lightly personal.
- Avoid: marketing language, AI hype, vague "效率提升", empty conclusions.
- Prefer: "我为什么这么判断", "边界是什么", "什么情况下不适用".
- Keep paragraphs short enough for mobile reading.
- Use lists for dense comparisons, not for every paragraph.

## Repository Map

- `src/data/blog/`: Markdown posts.
- `src/pages/index.astro`: homepage.
- `src/utils/postFilter.ts`: release filtering.
- `scripts/new-post.js`: create draft.
- `scripts/check-posts.js`: validate post metadata/content/images.
- `scripts/upload-post-images.js`: upload local post images to R2.
- `scripts/publish-post.js`: set release metadata and upload images.
- `scripts/upload-to-r2.js`: low-level image uploader.
- `docs/agentic-blog-workflow.md`: detailed workflow.
- `docs/blog-writing-rules.md`: writing and editorial rules.

## Done Definition

A blog change is done when:

- The post has clean frontmatter.
- The public article contains no internal notes.
- Images are public URLs and renderable.
- `npm run post:check` passes.
- `npm run build` passes.
- The user has reviewed the article before release.
