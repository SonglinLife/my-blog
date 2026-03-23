# My Blog

个人博客，基于 [AstroPaper](https://github.com/satnaing/astro-paper) 主题 + Astro 5 + Cloudflare Pages + R2。

- 站点：https://f3dlife.com
- 图片存储：https://img.f3dlife.com (Cloudflare R2)
- 仓库：https://github.com/SonglinLife/my-blog

## 工作流

```
                    ┌─────────────┐
                    │   Typora    │
                    │  写 Markdown │
                    └──────┬──────┘
                           │
                    粘贴/拖入图片
                           │
                           ▼
                ┌──────────────────────┐
                │  upload-to-r2.js     │
                │  自动上传图片到 R2    │
                │  返回 img.f3dlife.com│
                │  URL 嵌入 Markdown   │
                └──────────┬───────────┘
                           │
                    写完文章，添加
                  tags: [release]
                           │
                           ▼
                  ┌─────────────────┐
                  │  git add/commit │
                  │    git push     │
                  └────────┬────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  Cloudflare Pages      │
              │  自动拉取代码 → 构建    │
              │  只构建 release 文章    │
              └────────────┬───────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │  https://f3dlife.com │
                │  网站自动更新        │
                └─────────────────────┘
```

### 写一篇新文章

1. 在 `src/data/blog/` 下新建 `.md` 文件
2. 添加 frontmatter：

```yaml
---
title: '文章标题'
description: '文章简介'
pubDatetime: 2026-03-22
tags: [release, tech]  # 必须包含 release 才会发布
---
```

3. 用 Typora 写内容，粘贴图片会自动上传到 R2
4. `git add . && git commit -m "new post" && git push`
5. 等待 Cloudflare Pages 自动构建（约 1 分钟），网站即更新

### 发布规则

- `tags` 包含 `release` → 文章发布到网站
- `tags` 不含 `release` → 文章是草稿，存在仓库但不会构建
- 想取消发布？删掉 `release` tag，push 即可
- 过滤逻辑在 `src/utils/postFilter.ts`

## 环境配置

```bash
cp .env.example .env
# 编辑 .env 填入你的 Cloudflare / R2 凭据
```

`.env` 已在 `.gitignore` 中，不会提交到 Git。

### Typora 图片上传

Preferences → Image → Upload Service → Custom Command:

```
node /Users/wu/wsl/my-blog/scripts/upload-to-r2.js
```

脚本会从项目根目录的 `.env` 文件读取 R2 凭据，无需额外配置环境变量。

## 项目结构

```
src/
├── assets/icons/        # SVG 图标
├── components/          # Astro 组件（Header, Card, Tag 等）
├── data/blog/           # Markdown 文章放这里
├── layouts/             # 布局组件（Layout, PostDetails 等）
├── pages/               # 页面路由（首页、文章、标签、搜索、归档等）
├── scripts/             # 前端脚本（主题切换）
├── styles/              # 全局样式 & 排版样式
├── utils/               # 工具函数
│   ├── postFilter.ts    #   release 过滤逻辑
│   ├── getSortedPosts.ts#   文章排序
│   ├── getUniqueTags.ts #   标签提取
│   ├── generateOgImages.ts # OG 图片生成
│   └── ...
├── config.ts            # 站点配置（URL、作者、功能开关）
├── content.config.ts    # 内容集合 schema 定义
└── constants.ts         # 社交链接 & 分享配置
scripts/
└── upload-to-r2.js      # Typora 图片上传脚本（从 .env 读取配置）
.env                     # 凭据配置（不入 Git）
.env.example             # 凭据模板
```

## 本地开发

```bash
npm install
npm run dev       # 启动开发服务器 localhost:4321
npm run build     # 构建生产版本（含 Pagefind 索引生成）
npm run preview   # 本地预览构建结果
```

## 功能特性

- 明暗主题切换
- Pagefind 全文搜索
- 动态 OG 图片生成
- RSS 订阅 & Sitemap
- 文章归档页
- 标签分类
- 代码高亮（Shiki，支持 diff / highlight 标记）
- 目录自动生成（remark-toc）
- 响应式设计

## 技术栈

- [Astro 5](https://astro.build) - 静态站点生成
- [AstroPaper](https://github.com/satnaing/astro-paper) - 博客主题
- [Tailwind CSS 4](https://tailwindcss.com) - 样式
- [Pagefind](https://pagefind.app) - 静态搜索
- [Shiki](https://shiki.style) - 代码高亮
- [Satori](https://github.com/vercel/satori) + Sharp - OG 图片生成
- [Cloudflare Pages](https://pages.cloudflare.com) - 部署托管
- [Cloudflare R2](https://www.cloudflare.com/products/r2) - 图片存储
