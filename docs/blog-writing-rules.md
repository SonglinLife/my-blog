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

## Infrastructure Deep-Dive Mode

Use this mode for Kubernetes, storage, Linux, networking, Rust internals, distributed systems, and other systems posts where the reader needs to understand how something works under the hood.

This mode is the project's internal style for source-backed infrastructure writing. Treat it as a craft reference, not a voice clone: do not reuse another author's distinctive sentences, disclaimers, badges, diagrams, or screenshots.

### What The Article Should Feel Like

- A patient lab notebook that became a readable article.
- Dense enough for engineers who want source-level detail.
- Visual enough that the control flow or architecture is understandable before reading every paragraph.
- Honest about versions, assumptions, and places where the author is inferring.
- More like "let us walk the system path" than "here is a generic tutorial".

### Style Signature

The infrastructure style should read like a field guide to a mechanism:

- Start with a concrete system object, behavior, or misleading surface, not the author's diary.
- Put the reader inside a path: startup path, request path, object write path, scheduler path, recovery path, or source-call path.
- Use titles and headings as a map. A reader should understand the article's shape from the TOC alone.
- Give each section a job: define a concept, inspect evidence, follow a step, compare tradeoffs, or summarize a rule.
- Prefer short declarative paragraphs. Avoid soft setup phrases that delay the mechanism.
- Use first person only when it clarifies scope, uncertainty, or experiment ownership.
- Let diagrams, logs, source links, and measured outputs carry authority; prose should connect the evidence, not replace it.

Good opening patterns:

```markdown
RustFS 的 `.rustfs.sys/` 目录里，有两个很容易误判的对象：每盘一份的 `format.json`，以及看起来像系统元数据的 `pool.bin/xl.meta`。

如果只看目录结构，很容易把它们理解成某种中心元数据。但从启动拓扑、磁盘身份、对象 hash 和 `xl.meta/part.N` 的关系看，RustFS 的恢复模型更像一组分层规则。
```

```markdown
Kubernetes 创建一个带 PV 的 Pod 时，真正复杂的部分不是 Pod 对象本身，而是 kubelet、CSI plugin、mount pod 和宿主机挂载点之间的接力。

下面沿着一次创建流程，把每一步对应的组件、路径、日志和源码入口串起来。
```

Avoid opening patterns:

```markdown
我最近在看 X，突然有一个很朴素的问题。
```

```markdown
一开始我不太理解 X，于是用一个实验把这些问题串了一遍。
```

```markdown
本文不是完整说明，而是我的一些理解。
```

Better replacements:

| Weak | Better |
| --- | --- |
| `我最近在看 X` | `X 里最容易误判的是 Y` |
| `一开始有个疑问` | `这里有一个关键边界：...` |
| `我用实验串了一遍` | `下面用一个 N 节点/M 磁盘实验验证这条路径` |
| `不是完整说明` | `本文只关注 A/B/C 三个证据，不覆盖 D` |
| `我的理解是` | `从这些证据看，可以得到一个工作模型：...` |

### Pre-Draft Gate

Before writing the article body, create a short plan with four parts:

```markdown
## System Question
- What concrete mechanism or workflow are we explaining?

## Version And Environment
- Software version, commit/tag, runtime, topology, or lab setup.

## Evidence Plan
- Claim:
- Evidence anchor: source link / function / command output / log / screenshot / measured table.
- Status: verified / inferred / TODO.

## Visual Plan
- Image:
- Section:
- Purpose:
- Type: orientation diagram / workflow diagram / screenshot / terminal output / source excerpt.
- Required labels:
- Caption:
- Alt text:
```

Do not convert a rough technical note into polished prose before this plan exists. A smooth article without evidence and images is usually less trustworthy, not more.

### Common AI Failure Modes

Avoid the failure pattern exposed by prose-only technical drafts:

- No main map: the article explains many concepts but gives readers no architecture or workflow image near the top.
- Evidence hidden in prose: measurements, directory layouts, logs, and source findings are summarized but not shown.
- Source claims without anchors: functions, algorithms, startup paths, and recovery behavior are named without file paths, versions, or links.
- Concept sections without a path: the article explains terms one by one but does not walk a real request, object write, startup, failure, or recovery flow.
- Unmarked inference: tested facts, source-backed behavior, and author guesses are written with the same certainty.
- Tables doing diagram work: failure domains, shard layouts, object placement, or before/after state are described in tables when a visual would be clearer.
- The best mental model appears only at the end: if a final summary diagram is central, introduce it early and reuse it later.

### Preferred Shape

For mechanism or workflow posts:

```markdown
# 文章标题（YYYY）

短引言：对象是什么，为什么值得看，本文会追踪哪条路径。

![架构或主流程图](...)
Fig. One-sentence caption that names the system and scenario.

## 1 背景知识
## 2 整体架构/关键组件
## 3 Step 1：入口事件或请求
## 4 Step 2：第一个核心组件做了什么
## 5 Step 3：下游组件/数据面/元数据面
## 6 代码、日志或实验验证
## 7 总结
## 参考资料
```

For source-reading posts:

```markdown
## 1 问题与版本
## 2 从入口函数开始
## 3 关键数据结构
## 4 主流程
## 5 异常/边界/回滚路径
## 6 极简实验或日志验证
## 7 总结
## 参考资料
```

For a series:

- Put series links near the top.
- Name each part by the layer it explains, not just "Part 1/2/3".
- Make every part independently useful: context, scope, evidence, and takeaway must all be present.

### Titles

Good patterns:

- `图解 X 工作流：当 Y 时，背后发生了什么（YYYY）`
- `源码解析：X 的 Y 机制（YYYY）`
- `X 初探：架构、选型、读写流程（YYYY）`
- `X 再探：从实践中理解 Y（YYYY）`
- `X 设计与实现：模型、代码与验证（YYYY）`

Avoid:

- Copying another author's title exactly.
- Overclaiming with "终极", "完全", "最强".
- Titles that hide the concrete system and version.

### Evidence And Sources

- State the tested software versions early when behavior may depend on them.
- Prefer official docs, source code, design docs, RFCs, and reproducible experiments.
- Link source code to stable tags or commits when possible.
- If using logs or command output, capture real output. Redact secrets and private paths.
- When explaining an inferred behavior, mark it as inference and say what evidence supports it.

### Images And Captions

Before creating or revising images for this mode, read `docs/technical-visual-style.md`.

- Start long systems posts with a useful architecture or workflow image.
- Use diagrams to show components, calls, ownership, data flow, or state transitions.
- Use screenshots only when the UI, log, metric, or object browser is itself evidence.
- Put a centered caption immediately after each image, beginning with `Fig.`.
- Captions should name the scenario, not merely repeat the file name.
- Do not use decorative AI images for technical proof.
- When labels must be exact, prefer editable diagrams over AI-generated bitmap diagrams.

### Code, Logs, And Commands

- Introduce the question before the block: what should the reader notice?
- Keep snippets short enough to serve the argument.
- For long source excerpts, link to upstream and quote only the necessary function or interface.
- After a block, explain the implication in one short paragraph.
- If a command is expected to fail, show the relevant error and verify the non-zero exit code.

### Language Details

- Use Chinese for the explanatory spine.
- Keep established English terms inline when they are the actual API or common term: `schedulerName`, `PreFilter`, `binding cycle`, `metadata engine`, `object store`.
- Define the term once, then use it consistently.
- Prefer short paragraphs and numbered lists for state machines, phases, and component responsibilities.
- Use `**bold**` for the key observation or conclusion only.

### Final Check For This Mode

- [ ] The post starts from a concrete system question.
- [ ] Version, environment, or assumptions are explicit.
- [ ] There is at least one diagram, screenshot, source link, or verified command output for each major claim.
- [ ] The article has a clear path through the system, not a pile of disconnected notes.
- [ ] Image alt text and `Fig.` captions are meaningful.
- [ ] Technical images follow `docs/technical-visual-style.md`.
- [ ] No distinctive wording, assets, or signature elements from the reference author are copied.
- [ ] References are gathered under `参考资料`.

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
