# Agentic Blog Workflow

This blog is designed for AI-assisted writing: the author provides thoughts, constraints, examples, links, or voice notes; the AI agent turns them into a draft; the author reviews; the agent publishes only after approval.

## Roles

- Author: provides intent, taste, lived experience, and final approval.
- AI agent: drafts, edits, checks metadata, handles images, builds, and prepares release.
- Repository: enforces repeatable rules through scripts.

## Lifecycle

### 1. Capture

Collect the raw idea in any form:

- bullet notes
- copied chat
- outline
- meeting notes
- code snippets
- screenshots
- links

The agent should first restate:

- thesis
- target reader
- expected takeaway
- sensitive or uncertain points

### 2. Draft

Create a draft:

```bash
npm run post:new -- "标题" --tags ai,tech
```

Draft metadata keeps the post private by default:

- `pubDatetime: 1970-01-01T00:00:00+08:00`
- `tags: [draft]` or no `release`

### 3. Edit

Agent edits should improve:

- structure
- precision
- examples
- transitions
- title and description
- tag quality

Agent edits must not:

- fabricate experiences
- insert unverifiable claims
- publish internal notes
- turn the post into generic SEO content

### 4. Images

For local image references:

```bash
npm run post:images -- src/data/blog/post.md
```

The script uploads images to R2 and rewrites references to `R2_PUBLIC_URL`.

Before publishing, validate:

```bash
npm run post:check -- src/data/blog/post.md
```

### 5. Review

The agent should present a short review packet:

- final title
- description
- tags
- what changed from the user's notes
- unresolved TODOs or assumptions
- local preview URL

Do not publish until the user explicitly says to publish/release.

### 6. Publish

After approval:

```bash
npm run post:publish -- src/data/blog/post.md
npm run build
```

`post:publish` will:

- upload local images
- add `release`
- remove `draft` state by setting `draft: false`
- replace placeholder `pubDatetime` with current time

### 7. Ship

Before commit/push:

```bash
npm run post:check
npm run build
```

If the user asks for a commit or PR, include:

- post file
- changed assets/indexes
- no `.env`
- no private notes

## Image Handling Details

Required env vars:

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

Images are stored under:

```text
blog/YYYY/MM/DD/<safe-name>-<uuid>.<ext>
```

## Failure Modes

- Missing R2 credentials: keep local references in draft, do not publish.
- Local image not found: stop and ask for the source file.
- User has not approved release: keep `draft` or no `release` tag.
- Current factual claim is uncertain: verify or mark TODO.
- Build fails: fix before publishing.
