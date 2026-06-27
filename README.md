# F3D Life

AI-first personal blog built with Astro 5, Tailwind CSS, Pagefind, Cloudflare Pages, and Cloudflare R2.

- Site: https://f3dlife.com
- Image CDN: https://img.f3dlife.com
- Posts: `src/data/blog/`

## AI-First Workflow

This repository is designed for agentic writing:

1. The author gives rough thoughts, links, screenshots, or voice-note transcripts.
2. An AI agent creates or edits a draft.
3. The agent validates metadata, images, and build output.
4. The author reviews.
5. The agent publishes only after explicit approval.

Start with [AGENTS.md](/AGENTS.md). Detailed rules live in:

- [Agentic workflow](/docs/agentic-blog-workflow.md)
- [Writing rules](/docs/blog-writing-rules.md)
- [Publishing checklist](/docs/publishing-checklist.md)

## Common Commands

Create a draft:

```bash
npm run post:new -- "文章标题" --tags ai,tech
```

Check all posts:

```bash
npm run post:check
```

Upload local images referenced by a post:

```bash
npm run post:images -- src/data/blog/example.md
```

Publish after review approval:

```bash
npm run post:publish -- src/data/blog/example.md
npm run build
```

Local development:

```bash
npm install
npm run hooks:install
npm run dev
npm run build
npm run preview
```

## Publication Rules

A post is public only when:

- `tags` contains `release`
- `draft` is not `true`
- `pubDatetime` is not the placeholder date
- `pubDatetime` has passed the scheduled publish margin

Drafts should keep:

```yaml
pubDatetime: 1970-01-01T00:00:00+08:00
tags:
  - draft
```

Released posts should have:

```yaml
tags:
  - release
  - ai
draft: false
```

`release` and `draft` are internal control tags. They are not reader-facing topics.

## Image Upload

R2 credentials are loaded from `.env`.

```bash
cp .env.example .env
```

Required:

```bash
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_URL=
```

Optional:

```bash
BLOG_IMAGE_KEY_PREFIX=blog
```

Typora can still use:

```bash
node /absolute/path/to/scripts/upload-to-r2.js
```

AI agents should usually use:

```bash
npm run post:images -- src/data/blog/example.md
```

## Project Structure

```text
src/
  components/        Astro UI components
  data/blog/         Markdown posts
  layouts/           Page layouts
  pages/             Routes
  styles/            Global styles
  utils/             Content and path helpers
scripts/
  lib/               Shared script utilities
  new-post.js        Create draft posts
  check-posts.js     Validate posts
  upload-to-r2.js    Upload images to R2
  upload-post-images.js
  publish-post.js
docs/
  agentic-blog-workflow.md
  blog-writing-rules.md
  publishing-checklist.md
```

## Tech Stack

- Astro 5
- Tailwind CSS 4
- Pagefind
- Shiki
- Satori + Sharp
- Cloudflare Pages
- Cloudflare R2
