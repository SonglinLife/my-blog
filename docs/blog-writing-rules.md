# Blog Writing Rules

## Positioning

F3D Life is a personal technical blog about engineering practice, AI agents, data systems, tools, and long-term learning.

The blog should feel like a thoughtful working notebook, not a template site, marketing page, or generic tutorial farm.

## Article Quality Bar

Each publishable post should answer:

- What problem or question triggered this?
- What is the main judgment?
- What evidence, example, or experience supports it?
- What are the limitations?
- What should the reader do or think differently afterward?

## Structure

Prefer a clear arc:

1. Context
2. Tension or question
3. Main idea
4. Details and examples
5. Tradeoffs
6. Closing takeaway

Do not force every article into this shape. The article should read naturally.

## Voice

Use Chinese by default.

Good:

- specific
- calm
- reflective
- technically precise
- willing to say "I do not know yet"

Avoid:

- clickbait
- exaggerated AI claims
- empty productivity language
- generic "随着技术发展"
- filler conclusions like "总之，未来可期"
- unexplained jargon piles

## Titles

Good titles are concrete:

- "我如何判断一个 Skill 是否值得沉淀"
- "把 Spark 慢任务分析做成 Agent 工作流"
- "为什么我不想再手写博客发布流程"

Avoid:

- "关于 AI 的一些思考"
- "效率提升神器"
- "深度解析 XXX"

## Frontmatter

Description:

- 40-120 Chinese characters
- summarize the actual value
- avoid "本文主要介绍"

Tags:

- 1-4 public tags
- lowercase English preferred for stable URLs
- examples: `ai`, `agent`, `skill`, `spark`, `data`, `tools`, `life`
- `release` is internal only
- `draft` is internal only

## Links And Sources

- Link external source material when the post is based on it.
- For volatile facts, verify with primary sources before publishing.
- Do not cite private docs or internal systems unless the user explicitly approves and the content is safe.

## Code Blocks

Use fenced code blocks with language tags:

````markdown
```bash
npm run build
```
````

For long snippets, explain why the code matters before showing it.

## Images

- Use meaningful alt text.
- Upload local images before release.
- Do not publish sensitive screenshots.
- If an image is decorative and adds no information, remove it.

## Pre-Publish Checklist

- [ ] User approved publication.
- [ ] No TODO or drafting brief remains.
- [ ] No local image references remain.
- [ ] No private/sensitive data.
- [ ] `description` is useful.
- [ ] Tags are reader-facing.
- [ ] `npm run post:check` passes.
- [ ] `npm run build` passes.
