---
title: 一个优秀的 skill 怎么写
author: F3D
pubDatetime: 2026-03-22T00:00:00+08:00
description: 翻译自X上的一篇文章，讲述了如果编写一个 skill
tags:
  - release
  - skill
  - ai
---

来源: [Lessons from Building Claude Code: How We Use Skills — Thariq (@trq212)](https://x.com/trq212/status/2033949937936085378)

## 核心原则

### 1. Gotchas 段落是最高价值内容

Skill 中信号密度最高的部分是 Gotchas（常见陷阱/注意事项）。应从 Claude 使用 skill 时的实际失败案例中积累，并持续更新。

**How to apply:** 每个 skill 都应包含一个 `## Gotchas` 或 `## 注意事项` 段落，记录：

- Claude 常犯的错误
- 容易混淆的概念
- 边界条件和异常情况
- 环境差异导致的问题

### 2. Skills 是文件夹，不只是 Markdown

Skill 最有价值的部分不是文本说明，而是它可以包含脚本、数据、资源等文件，供 Claude 在运行时发现和使用。

**How to apply:** 在 SKILL.md 中明确描述 `scripts/`、`references/`、`assets/` 等子目录的内容和用途，让 Claude 知道有哪些工具可用、何时该读取哪个文件。

### 3. Progressive Disclosure（渐进式信息披露）

把整个文件系统视为上下文工程的一部分。不要把所有信息塞进 SKILL.md，而是告诉 Claude 哪些文件在哪里，它会在合适的时机去读取。

**How to apply:**
- SKILL.md 放核心指令和元数据
- 详细参考信息放在 `references/` 下的独立 markdown 文件中
- 代码示例放在 `assets/` 或 `examples/` 中
- 在 SKILL.md 中用简短描述指向这些文件

### 4. Verification / 验证指引

验证类 skill 对确保输出正确性极其有价值。Anthropic 认为值得花一整周时间专门打磨验证类 skill。

**How to apply:** 每个 skill 应说明：
- 成功执行的标志是什么
- 如何验证输出的正确性
- 常见的错误输出长什么样

### 5. 知识型 Skill 要突破 Claude 的默认思维

如果 skill 主要传递知识，应聚焦于那些会让 Claude 偏离其默认行为的信息——即 Claude 不知道或容易搞错的东西。

**How to apply:** 不要重复 Claude 已经知道的通用知识，而是：
- 强调特定领域的非直觉规则
- 记录内部系统的特殊约定
- 说明与常见做法不同的地方

### 6. 避免过度具体，保留灵活性

给 Claude 必要的信息，但允许它根据具体情况灵活应变。Skill 是高复用的，过于具体的指令会限制适用性。

**How to apply:**
- 用框架和维度代替硬编码的检查清单
- 说明"为什么"而不只是"做什么"
- 允许 Claude 在规则范围内做判断

## Skill 质量检查清单

优化一个 skill 时，逐项检查：

- [ ] 有 Gotchas / 注意事项段落？
- [ ] SKILL.md 中描述了 scripts/ 等子目录的内容？
- [ ] 有验证/测试指引（怎么判断输出正确）？
- [ ] 知识内容聚焦于 Claude 不知道的信息？
- [ ] 指令留有灵活性，没有过度约束？
- [ ] 跨 skill 依赖关系清晰说明？