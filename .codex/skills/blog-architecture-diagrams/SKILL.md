---
name: blog-architecture-diagrams
description: Use when creating or revising technical blog images for this repository, especially architecture diagrams, workflow diagrams, layer diagrams, state-change diagrams, storage topology diagrams, or any image where Mermaid would be too weak for precise layout, grouping, arrows, labels, or mobile readability.
---

# Blog Architecture Diagrams

## Purpose

Create precise, editable engineering diagrams for this blog. Use this skill whenever a post needs an architecture, workflow, topology, state-change, storage, networking, runtime, Kubernetes, Linux, Rust internals, or distributed-systems diagram.

The default output should be an editable/reproducible diagram source plus an exported SVG or PNG in `src/data/blog/<post-slug>-assets/`. Mermaid is only acceptable for small drafts or very simple linear flows.

## Required Project Context

Before drawing, read `docs/technical-visual-style.md`. For detailed style heuristics, also read `references/diagram-style.md`.

Keep the repository rules from `AGENTS.md`: do not copy third-party diagrams, do not invent evidence, do not leave private data or local-only image paths in released posts, and ensure every image has meaningful alt text and a `Fig.` caption.

## Workflow

1. Define the diagram contract before drawing:
   - question answered by the image;
   - exact components, files, APIs, commands, states, or objects to label;
   - control/data flow direction;
   - arrow lanes: reserved horizontal/vertical corridors where arrows can travel without crossing node labels;
   - verified evidence source for each major label.
2. Choose the rendering path:
   - **Programmatic SVG** for most serious architecture diagrams. Prefer `scripts/render-architecture-svg.js` with a JSON spec when the diagram needs zones, arrows, numbered steps, precise labels, or repeated style.
   - **Handwritten SVG/HTML/CSS** when the layout needs custom geometry beyond the helper script.
   - **Terminal screenshot** via `scripts/render-terminal-screenshot.js` when output/logs are the evidence.
   - **Mermaid** only for quick drafts, tiny sequence/flow diagrams, or temporary planning notes. Do not use Mermaid as the final format for complex system maps.
3. Create or edit sources next to the post assets:
   - `src/data/blog/<slug>-assets/<name>.diagram.json`
   - `src/data/blog/<slug>-assets/<name>.svg`
   - optional exported PNG if the renderer/browser pipeline needs it.
4. Render and inspect:
   - run the relevant script;
   - open the SVG/PNG or inspect it with screenshot/image tools when possible;
   - verify labels, arrows, mobile readability, and no clipped text.
5. Embed the image directly beside the claim it supports:
   - meaningful Markdown alt text;
   - caption begins with `Fig.`;
   - surrounding prose says what to notice.

## Programmatic SVG Quick Start

Create a JSON spec:

```json
{
  "title": "Example storage write path",
  "width": 1600,
  "height": 900,
  "zones": [
    {"id": "client", "label": "Client node", "x": 80, "y": 120, "w": 420, "h": 620, "tone": "green"},
    {"id": "storage", "label": "Persistent layer", "x": 900, "y": 120, "w": 520, "h": 620, "tone": "yellow"}
  ],
  "nodes": [
    {"id": "app", "label": "Application\nPOSIX write()", "x": 150, "y": 230, "w": 260, "h": 110, "tone": "blue"},
    {"id": "meta", "label": "Metadata engine\nTxn keys", "x": 980, "y": 230, "w": 300, "h": 120, "tone": "yellow", "shape": "database"}
  ],
  "arrows": [
    {"from": "app", "to": "meta", "label": "1. update metadata", "step": 1}
  ],
  "notes": [
    {"text": "Labels must come from verified commands, source code, or docs.", "x": 90, "y": 790, "w": 900}
  ]
}
```

Render:

```bash
npm run diagram:check -- src/data/blog/<slug>-assets/<name>.diagram.json
npm run diagram:render -- \
  src/data/blog/<slug>-assets/<name>.diagram.json \
  src/data/blog/<slug>-assets/<name>.svg
```

## Style Requirements

- Use large plain canvases: `1600x900`, `1800x1000`, or wider for dense systems.
- Use muted flat colors and thin outlines:
  - blue: pods, services, control-plane components;
  - green: clients, agents, plugins, sidecars;
  - yellow/orange: files, disks, buckets, objects, persisted metadata;
  - gray: hosts, kernels, queues, neutral substrate;
  - accent blue: current path or selected step.
- Use explicit topology: hosts, pods, disks, buckets, object stores, queues, metadata engines, or runtime boundaries should appear as real zones, not generic cards.
- Put exact labels in the image: function names, CLI names, file paths, resource names, object keys, API calls, state names.
- Use numbered step circles for flows. Use dashed arrows only when the surrounding prose or caption defines the meaning.
- Keep arrows quiet and semantic:
  - route arrows through whitespace corridors, not through component text;
  - prefer short orthogonal paths with one or two bends;
  - avoid large triangular heads, long decorative detours, and self-crossing paths;
  - place labels beside arrows or in reserved whitespace, not directly on top of busy line intersections;
  - put step circles near the start of a segment but offset from labels and node borders.
- Avoid huge titles inside the image, decorative gradients, neon accents, slide-cover composition, fake dashboards, fake terminal output, and copied third-party layout.

## Quality Gate

Before considering a diagram done:

- source is editable or reproducible;
- `npm run diagram:check -- <diagram.json>` passes for every programmatic SVG source;
- every major label is verified;
- the diagram answers one concrete question;
- arrows encode real control/data/state direction;
- arrows do not cross node labels, pass through step circles, or require the reader to untangle decorative bends;
- text is readable at mobile width;
- no third-party diagram, watermark, badge, or distinctive layout was copied;
- exported asset is referenced with meaningful alt text and a `Fig.` caption.
