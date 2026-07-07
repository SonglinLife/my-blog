---
title: "用 React 写视频：Remotion 在宠物账单项目里的实践笔记（2026）"
author: F3D
pubDatetime: 2026-07-07T21:09:47+08:00
description: "把一张宠物医院账单做成 90 秒讲解视频时，为什么和怎么用 Remotion：Composition、Series、帧时间轴，以及数字滚动与画面组装的关键模式。"
tags:
  - release
  - tools
  - video
  - react
draft: false
---

写一段「为什么宠物医院账单这么贵」的口播稿、再把它做成 90 秒的讲解视频，听起来是剪辑活。但在排版层面，它和写一篇数据文章几乎一样：要有对比、要有结构条、要有节奏。Remotion 的卖点是把这件原本要靠 After Effects 时间轴做的事，搬到了 React 组件里。

本文不是 Remotion 教程，而是我在做一个具体项目（宠物医院账单拆解）时，把这套工具拆开来用的笔记：哪些模式我留下来了、哪些被我重写了、以及为什么当一段视频本质上是「数据展示」时，Remotion 比剪辑软件更顺手。

项目代码已经独立成 `pet-bill-video/`，本文涉及的所有源码都来自这个仓库：1920×1080 横版、30fps、Remotion 4.0.485、React 19。

## 目录

- [1 系统问题：为什么是代码，而不是时间轴](#1-系统问题为什么是代码而不是时间轴)
- [2 顶层抽象：Composition + Series](#2-顶层抽象composition--series)
- [3 一个场景长什么样](#3-一个场景长什么样)
- [4 组件层：把动效做成可复用原语](#4-组件层把动效做成可复用原语)
- [5 时间用帧计：唯一可执行的参考系](#5-时间用帧计唯一可执行的参考系)
- [6 Studio 预览 + 选择性渲染](#6-studio-预览--选择性渲染)
- [7 出片工作流：Remotion + 剪映](#7-出片工作流remotion--剪映)
- [8 边界与取舍](#8-边界与取舍)
- [9 小结](#9-小结)
- [参考资料](#参考资料)

## 1 系统问题：为什么是代码，而不是时间轴

一段宠物账单视频真正要解决的，是「一组数字 + 一组对照 + 一段解释」的排版问题：

- Scene01：上海 ¥5,000 vs 四线 ¥300，同一只猫、同一种病
- Scene03：挂号 100、化验 780、B超 860、输液 1260……累加滚动到 5,000
- Scene04：5,000 里有 38% 是人力、22% 是房租、净利只剩 8%
- Scene05：同一支抗病毒注射剂，上海 ¥480，小诊所 ¥180

这些画面对排版的精度要求高于对镜头运动的要求：字号、字距、数字等宽、颜色对比、出现时机。换到 After Effects 里，就是在一堆关键帧之间做微调；换到 CSS / React 里，就是一个 `interpolate(frame, [a, b], [0, 1])` 配 `transform: translateY`。

这就是 Remotion 的工作：把视频的「时间」暴露成一个 `useCurrentFrame()`，把每个画面渲染成一个普通 React 组件，每个组件里的动画就是 `interpolate` 或 `spring`。所有数据（金额、占比、出现时机）都写在 TS 文件顶部的常量里，和 React state、props 一样可组合、可类型化。

这套抽象的代价，是「时间」单位必须从秒换成帧：30fps 下，2.5 秒 = 75 帧。这件事在剪映里很自然，在 Remotion 里会反复出现。下面所有 `delay: 30`、`durationInFrames: 75` 都是这个意思。

## 2 顶层抽象：Composition + Series

一个 Remotion 项目由两类东西组成：

- **Composition**：一段可独立预览 / 渲染的「视频片段」。它有 `width / height / fps / durationInFrames`。
- **Series.Sequence**：把多个 Composition 串成一条更长的视频。

注册表 `src/Root.tsx` 把每一个场景注册成一个 Composition：

```tsx
const FPS = 30;
const SIZE = { width: 1920, height: 1080 };

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="FullVideo"
        component={FullVideo}
        durationInFrames={TOTAL_DURATION}
        fps={FPS}
        {...SIZE}
      />
      <Composition id="Scene01-Contrast" component={Scene01Contrast} ... />
      <Composition id="Scene03-Bill"      component={Scene02Bill}      ... />
      ...
    </>
  );
};
```

`id` 是 Studio 左侧和 `npx remotion render` 时的唯一 key。`FullVideo` 这条 Composition 把所有场景用 `Series` 串起来，时长从 `DURATIONS` 求和：

```tsx
export const DURATIONS = {
  contrast: 180, // 6s
  photo:    150, // 5s
  bill:     330, // 11s
  costBar:  270, // 9s
  strike:   210, // 7s
  close:    150, // 5s
};
export const TOTAL_DURATION = Object.values(DURATIONS).reduce((a, b) => a + b, 0);
```

**这种「单场景独立 Composition + 顶层 Series 串联」是关键的工程选择**：

1. Studio 可以单独预览任意一个场景，调一行参数不用重看 43 秒全片。
2. `npx remotion render Scene03-Bill out/bill.mp4` 可以只出账单场景，丢进剪映和配音对位。
3. 加一个场景不会牵动其他场景的时长，只需要改 `DURATIONS` 一个对象。

不这么组织的人会陷入「全片是一个 Composition、一个巨长 React 组件」的写法，那种写法在前几秒还行，到 Scene04 的成本条 + 图例 + 刻度尺就开始失控。

## 3 一个场景长什么样

以 Scene03 账单逐行浮现为例。每一行账单项都带一个 `at` 字段，表示「从第几帧开始出现」。合计用 `interpolate` 把每行同步累加：

```tsx
const ITEMS = [
  { name: "挂号 + 诊查",   price: 100,  at: 30  },
  { name: "血常规 + 生化", price: 780,  at: 70  },
  { name: "B超 + X光",     price: 860,  at: 110 },
  { name: "输液治疗 ×3天", price: 1260, at: 150 },
  { name: "住院护理 ×3天", price: 900,  at: 190 },
  { name: "药品 + 耗材",   price: 1100, at: 230 },
];

const total = ITEMS.reduce((sum, item) => {
  return sum + interpolate(frame, [item.at, item.at + 20], [0, item.price], {
    extrapolateLeft:  "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
}, 0);
```

每行入场动画只有三件事：`opacity: 0 → 1`、`translateY: 20px → 0`、虚线分隔线。这三件事全部塞进一个 6 行的子组件 `<Row />` 里。合计那里再叠一个会计式双划线（`borderBottom: "6px double rgba(255,213,60,0.65)"`），整张收据就有了「真账单」的味道。

这种写法的好处是：**每一行出现时机就是一个数字**，跟配音脚本里「念到哪句亮哪行」一一对应。改配音稿的时候，不需要碰任何视觉代码，只改 `ITEMS[].at` 这一个数组。

Scene04 成本条是同一种模式，但用了 `spring` 而不是 `interpolate`：

```tsx
const grow = spring({
  frame: frame - seg.at,
  fps,
  config: { damping: 200 },  // 高阻尼 = 极缓
  durationInFrames: 30,
});
return <div style={{ width: `${seg.pct * grow}%`, backgroundColor: seg.color, height: "100%" }} />;
```

`interpolate` 是线性 / 缓动映射，适合「数字滚动」「位移」。`spring` 是带物理弹簧的动画，适合「生长」「弹出」。Scene04 的成本条 5 段依次长出，用 `damping: 200` 故意压成「几乎不弹」，配合财经纪录片的克制感。

## 4 组件层：把动效做成可复用原语

所有场景复用同一个组件层 `src/components/`：

| 组件 | 职责 |
|---|---|
| `Backdrop` | 多层背景：渐变底 + 角落微光 + 账本网格 + 胶片颗粒 + 暗角 |
| `Kicker` | 每屏左上角的眉题：黄色小竖条 + 大字距灰字 |
| `Hairline` | 发丝线，两端渐隐，用 `progress` 控制画出比例 |
| `FadeUp` | 标准入场：opacity + translateY |
| `CountUp` / `Money` | 数字滚动 / 静态金额，¥ 符号缩小到 0.48em 并降透明度 |
| `KenBurns` | 全幅照片 + 极缓慢推近 + 暗蒙版 + 底部渐变 |

挑两个最关键的看。

**`FadeUp` 是入场动画的全部**。它把入场参数化为三个东西：`delay` / `duration` / `distance`，调用方只在 `delay` 上做文章，整片风格才能保持一致：

```tsx
export const FadeUp: React.FC<{
  delay?: number; duration?: number; distance?: number;
  children: React.ReactNode; style?: React.CSSProperties;
}> = ({ delay = 0, duration = 18, distance = 36, children, style }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [delay, delay + duration], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div style={{ opacity: t, transform: `translateY(${(1 - t) * distance}px)`, ...style }}>
      {children}
    </div>
  );
};
```

如果一个组件库入场动画有 5 种（淡入、上滑、缩放、翻转、滑入），整部视频看起来就是模板做的。只有一种入场、参数化 delay，整部视频才像同一个编辑部出的。

**`CountUp` / `Money` 是数字的字体排版守门人**。前者滚数字，后者静态显示，但两者共用同一套排版：

```tsx
<span style={{ fontVariantNumeric: "tabular-nums", ...style }}>
  <span style={{ fontSize: "0.48em", opacity: 0.72, marginRight: "0.08em" }}>¥</span>
  {Math.round(value).toLocaleString("en-US")}
</span>
```

两件事看似小，但少了就翻车：

- `tabular-nums`：等宽数字。数字滚动时每位宽度一致，不会因为「1」窄、「8」宽导致抖动。
- `¥` 字号缩到 0.48em、透明度降到 0.72：是财经排版的常规处理，让金额视觉中心是数字本身，不是符号。

`KenBurns` 处理「真实照片」场景。它和 `Backdrop` 是一对：`Backdrop` 给纯版式场景打底，`KenBurns` 给照片场景打底：

```tsx
<KenBurns src={staticFile("photos/real_04_vet_lobby.jpg")} overlayOpacity={0.62}>
  <AbsoluteFill style={{ justifyContent: "flex-end", padding: "0 130px 120px" }}>
    <FadeUp delay={10}>
      <Kicker>走进一家一线城市宠物医院</Kicker>
      ...
    </FadeUp>
  </AbsoluteFill>
</KenBurns>
```

`overlayOpacity` 0.6-0.65 是「文字永远能落在深色上」的兜底；底部 4-stop 渐变把下半区压到接近全黑；推近速度每秒 1.5%，有呼吸感但不抢戏。这些参数都不是理论值，是反复渲染 6 次以后留下的「刚好」值。

## 5 时间用帧计：唯一可执行的参考系

Remotion 里所有时间都是「帧」。这不是习惯问题，是设计问题：

- `useCurrentFrame()` 返回当前帧号。
- `interpolate(frame, [from, to], [0, 1])` 把帧号映射到任意值。
- `delay: 30` = 第 1 秒。
- `durationInFrames: 75` = 2.5 秒 @ 30fps。

代价是：**所有的 `delay / duration` 都不能直接照抄配音脚本里的「秒数」**，要先 × fps。

但也带来了一个意外的好处：**所有动画都可以写成「帧索引」驱动的逻辑，而不是时间驱动的逻辑**。Scene03 的「合计累加」就是一个例子：

```tsx
const total = ITEMS.reduce((sum, item) => {
  return sum + interpolate(frame, [item.at, item.at + 20], [0, item.price], { ... });
}, 0);
```

`total` 是一个会随帧号变化的数。这就是「数据展示」型视频的真正好处：数字滚动到哪个位置，合计就涨到哪个数，**没有「动画和数据」分离**。在 After Effects 里做这件事，要先在 Excel 里算好每一帧的累计值，再手敲关键帧。

配音定稿以后的工作流变成这样：

1. 拿到配音 mp4，导出每句起止时间（秒）。
2. 把秒数 × 30 = 帧号，填进 `ITEMS[].at` / `SEGMENTS[].at`。
3. Studio 实时拖时间轴，肉眼复核。
4. 全片渲染，丢进剪映铺到配音轨。

第 3 步是关键——Studio 让「拖时间轴」从盲调变成可视化。`delay: 70` 改成 `delay: 65` 是 0.17 秒的差异，肉眼能感觉到。

## 6 Studio 预览 + 选择性渲染

Remotion Studio 是这套工具链最值钱的部分：

```bash
npm run dev
```

打开浏览器，左侧是所有 Composition 列表，点哪个就预览哪个。中间是渲染画布，下方是时间轴 / 当前帧 / FPS / 缩放比。右侧是 props 面板（如果 Composition 接了 props）。

它能做到几件剪辑软件做不到的事：

- **改 `DURATIONS.contrast` 从 180 → 150，全片时长同步更新**，不用重排其他场景的入点。
- **直接看 Scene05 划线动画的进度**：`progress` 是不是从 0 长到 1，缓动曲线是不是太冲。
- **选中任意帧、按 `J/K/L` 反向 / 暂停 / 正向**，逐帧排查「这一帧数字对不对」。
- **`npx remotion still Scene01-Contrast out/check.png --frame=150` 单独导一帧**，省去开 Figma 截图的步骤。

注意 `package.json` 里只列了三个 npm script：

```json
"scripts": {
  "dev":   "remotion studio",
  "render":"remotion render",
  "still": "remotion still"
}
```

剩下的 `npx remotion render FullVideo out/full.mp4` 都是直接调用 CLI。Remotion 的 CLI 本身是参数化的：`npx remotion render <composition-id> <output-file>`，不需要写配置文件。

## 7 出片工作流：Remotion + 剪映

Remotion 不是 Premiere / Final Cut 的替代品。它擅长「数据可视化 + 可复用模板」，不擅长「剪辑 + 配音 + 多轨字幕 + 转场音效」。一个务实的分工：

| 阶段 | 工具 |
|---|---|
| 关键帧画面 | Remotion（全片渲染或单场景渲染） |
| 配音 | AI TTS 或真人录音 |
| BGM / 转场音效 / 字幕 | 剪映 |
| 最终合成 | 剪映 |

具体步骤：

1. 配音定稿，把每句秒数转成帧号，写进 `ITEMS[].at` 等常量。
2. Studio 复核节奏。
3. `npx remotion render FullVideo out/full.mp4` 出整条，作为剪映的主轨道。
4. 剪映里铺配音轨、BGM、字幕、关键帧转场。
5. 如果某一段节奏对不上，回 Remotion 改 `delay`，重新渲染那一段 mp4 替换。

这套分工下，Remotion 负责的是「画面」，剪映负责的是「节奏」。两个工具的边界很清晰，不用互相挤。

## 8 边界与取舍

Remotion 不是万能的。几个我用下来觉得要小心的边界：

**字体注册是静态的**。`src/fonts.ts` 在 `Root.tsx` import 时跑一次 `loadFont`，Composition 加载时字体文件已被打包进 webpack。运行时不能动态切字体，否则要重新打包。`@remotion/fonts` 的 `waitForFont` 是个护城河组件，可以等待字体加载完再开始渲染，避免渲染时字体未就绪。

**中文 web 字体很大**。SourceHanSansCN 的 4 个字重加起来 33 MB，是项目体积的主要来源。如果要瘦身，只留 `Bold` + `Heavy` 两个常用字重就够 90% 的场景。`@remotion/fonts` 还会把字体转成 `woff2` 内联进 bundle（看版本），首次渲染会慢几秒。

**数字必须等宽**。如果一个画面里有「5,000」「500」「300」同时出现，没开 `tabular-nums`，宽度会跳。Scene01 的双数字滚动靠 `tabular-nums` 才能稳。同理 ¥、% 这类符号的尺寸不能和数据数字一样大，否则视觉重心会偏。

**「帧」这个单位会泄漏到所有协作场景**。配音员用秒、剪辑师用秒、Remotion 用帧。任何一次协作都要多一道「秒 → 帧」的换算。把所有 `delay / at` 集中放在文件顶部的常量数组里，至少让换算只发生一次。

**数据驱动动画的诱惑**。React 的 props 化很诱人，会让人想把「账单项」「成本占比」做成 JSON 配置文件 + 动态加载。我没这么做，原因有两个：① 这条视频的数据是固定的，没必要为它做一套配置加载层；② 配音节奏和数据是绑死的，配音定稿后改一项就要同步改 `at`，拆出去反而麻烦。

## 9 小结

把视频当成「数据驱动的 React 组件 + 时间映射函数」之后，几件事变得顺理成章：

- 一行 `interpolate(frame, [a, b], [0, 1])` 比一段关键帧动画更可读、可复用、可单元化。
- 数字滚动和合计累加的同步，可以直接靠「同一帧号喂给两个 `interpolate`」完成。
- 整部视频的视觉一致性，靠一个入场动画（`FadeUp`）和一个数字排版（`CountUp` / `Money`）守门。
- Studio 的逐帧预览 + `npx remotion still` 的单帧导出，把「改一行调一次」的成本压到秒级。

Remotion 不适合做剧情片、广告片、转场密集的剪辑作品。它适合「数据 + 节奏 + 排版」型视频——财经讲解、教学演示、产品 demo、数据可视化短片。如果你的视频本质上是「把几张图表讲清楚」，Remotion 比剪辑软件更接近问题本身。

整个项目代码在 `pet-bill-video/` 下，6 个 Composition + 1 个 FullVideo，加起来不到 800 行 TSX。任何 React 项目都可以原地迁入，不引入额外运行时复杂度。

## 参考资料

- Remotion 官方文档：https://www.remotion.dev/
- 项目仓库：`pet-bill-video/`（package.json `@remotion/cli` 4.0.485、remotion 4.0.485、react 19）
- 关键文件：
  - `src/Root.tsx` —— Composition 注册表
  - `src/FullVideo.tsx` —— Series 串联 + `DURATIONS`
  - `src/theme.ts` —— 配色 + 字体常量
  - `src/fonts.ts` —— `loadFont` + `staticFile`
  - `src/components/CountUp.tsx` —— 数字滚动 + ¥ 排版
  - `src/components/FadeUp.tsx` —— 统一入场动画
  - `src/components/KenBurns.tsx` —— 照片缓推 + 暗蒙版
  - `src/scenes/Scene02Bill.tsx` —— 收据式逐行浮现 + 合计累加
  - `src/scenes/Scene03CostBar.tsx` —— 分段 spring + 图例