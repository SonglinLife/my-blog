---
name: blog-architecture-diagrams
description: Use when creating or revising technical blog images (作图/画图/配图/架构图/流程图/示意图) for this repository, especially architecture diagrams, workflow diagrams, layer diagrams, state-change diagrams, storage topology diagrams, or any image where HTML/CSS, SVG overlays, or Mermaid alternatives are needed for precise layout, grouping, arrows, labels, or mobile readability.
---

# Blog Architecture Diagrams

## Layout And Portability

This skill works with any AI coding agent (Claude Code, Codex, Cursor, and others). The canonical source lives at `.agents/skills/blog-architecture-diagrams/`; `.claude/skills/` and `.codex/skills/` hold symlinks to it so per-agent skill discovery finds the same files. All commands below are `npm run` wrappers defined in the repository root `package.json`, so they work identically from any agent — never reference `.codex/` or `.claude/` paths in commands or docs.

## Purpose

Create precise, editable engineering diagrams for this blog. Use this skill whenever a post needs an architecture, workflow, topology, state-change, storage, networking, runtime, Kubernetes, Linux, Rust internals, or distributed-systems diagram.

The default output should be an editable/reproducible diagram source plus an exported SVG or PNG in `src/data/blog/<post-slug>-assets/`. Prefer **HTML/CSS diagram pages using the local Tailwind-backed diagram kit** for serious diagrams because CSS Grid, Flexbox, custom properties, component classes, and inline SVG overlays express layout more efficiently than hand-authored SVG coordinates. Mermaid is only acceptable for small drafts or very simple linear flows.

## Required Project Context

Before drawing, read `docs/technical-visual-style.md`. For detailed style heuristics, read `references/diagram-style.md`. When using the default HTML/CSS path, also read `references/html-css-diagram-workflow.md`.

Keep the repository rules from `AGENTS.md`: do not copy third-party diagrams, do not invent evidence, do not leave private data or local-only image paths in released posts, and ensure every image has meaningful alt text and a `Fig.` caption.

## Workflow

1. Define the diagram contract before drawing:
   - question answered by the image;
   - exact components, files, APIs, commands, states, or objects to label;
   - control/data flow direction;
   - arrow lanes: reserved horizontal/vertical corridors where arrows can travel without crossing node labels;
   - verified evidence source for each major label.
2. Choose the rendering path:
   - **HTML/CSS diagram page (default)** for most architecture/workflow/topology diagrams. Use `assets/html-diagram-template.html` plus `assets/diagram-kit.css`, keep the source as `<name>.diagram.html`, and export to PNG/SVG for the post.
   - **Programmatic SVG** when deterministic geometry lint is more valuable than CSS layout, or when a small existing `.diagram.json` only needs a narrow edit. Use `scripts/render-architecture-svg.js` with a JSON spec.
   - **Handwritten SVG** only for custom geometry that is simpler as vector paths than DOM layout.
   - **Terminal screenshot** via the repository script `node scripts/render-terminal-screenshot.js` (repo root, not inside this skill) when real command output/logs are the evidence. Never fabricate terminal output or dashboards as a diagram.
   - **Mermaid** only for quick drafts, tiny sequence/flow diagrams, or temporary planning notes. Do not use Mermaid as the final format for complex system maps.
3. Create or edit sources next to the post assets:
   - preferred: `src/data/blog/<slug>-assets/<name>.diagram.html`
   - exported: `src/data/blog/<slug>-assets/<name>.png` or `<name>.svg`
   - fallback SVG path: `<name>.diagram.json` plus `<name>.svg`
4. Render and inspect:
   - run the relevant script;
   - open the SVG/PNG or inspect it with screenshot/image tools when possible;
   - verify labels, arrows, mobile readability, and no clipped text.
5. Embed the image directly beside the claim it supports:
   - meaningful Markdown alt text;
   - caption begins with `Fig.`;
   - surrounding prose says what to notice.

## HTML/CSS Quick Start

Copy the template:

```bash
cp .agents/skills/blog-architecture-diagrams/assets/html-diagram-template.html \
  src/data/blog/<slug>-assets/<name>.diagram.html
```

Edit the HTML source with real labels and source-backed facts. Use the `dg-*` classes from `assets/diagram-kit.css` for common components.

**Arrows are declared, never drawn.** Give nodes `id`s and declare each arrow as an element; the pipeline routes it from real rendered positions:

```html
<div class="dg-arrow" data-from="init-storage" data-to="layout" data-label="read volumes" data-step="1"></div>
```

Do not hand-write SVG `<path>` coordinates or absolutely-positioned step circles — that is how arrows end up crossing text. Available attributes: `data-route` (`h`/`v`/auto), `data-exit`/`data-enter` (edge overrides), `data-exit-at`/`data-enter-at` (0..1 along the edge), `data-mid`/`data-lane` (middle-segment position), `data-tone="muted"` (dashed gray secondary), `data-label`, `data-step`, `data-label-at` (0..1 label anchor along the path).

Validate the source:

```bash
npm run diagram:html:check -- src/data/blog/<slug>-assets/<name>.diagram.html
```

Export (requires Chrome/Chromium):

```bash
npm run diagram:html:export -- \
  src/data/blog/<slug>-assets/<name>.diagram.html \
  src/data/blog/<slug>-assets/<name>.png
```

The export pipeline compiles the Tailwind-backed kit, runs the arrow runtime in headless Chrome, bakes the computed arrows into a static self-contained `.built.html`, and **runs a geometry audit**: any arrow crossing node text, any label/step chip overlapping content, or any out-of-bounds route is an error and the PNG is not exported. Fix the source (labels, `data-mid`, `data-label-at`, layout) instead of overriding; `--force` exists only for deliberate exceptions. After a successful export, always open the PNG with an image Read and check every label yourself before embedding.

If the machine has no Chrome/Chromium, run `npm run diagram:html:build -- <diagram.html> <out.built.html>` and open the built file in any browser — arrows render live there — then capture the fixed-size canvas manually.

## Programmatic SVG Fallback

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

For review loops, use structured output when useful:

```bash
npm run diagram:check -- --format json src/data/blog/<slug>-assets/<name>.diagram.json
```

The validator checks path/node collisions, label overlap, arrow self-crossing, path length ratio, minimum segment length, start/end gap, bend radius, and whether step circles visually belong to their arrow path. Fix those issues in the JSON source before hand-tuning exported SVG.

## Style Requirements

- Use large plain canvases: `1600x900`, `1800x1000`, or wider for dense systems.
- Prefer the local diagram kit component classes for consistency: `dg-canvas`, `dg-zone-*`, `dg-node-*`, `dg-pool-*`, `dg-step`, `dg-label`, `dg-note`, and `dg-legend`. Add small per-diagram CSS only for diagram-specific grid tracks, dimensions, and arrow coordinates.
- Use muted flat colors and thin outlines:
  - blue: pods, services, control-plane components;
  - green: clients, agents, plugins, sidecars;
  - yellow/orange: files, disks, buckets, objects, persisted metadata;
  - gray: hosts, kernels, queues, neutral substrate;
  - accent blue: current path or selected step.
- Use explicit topology: hosts, pods, disks, buckets, object stores, queues, metadata engines, or runtime boundaries should appear as real zones, not generic cards.
- Put exact labels in the image: function names, CLI names, file paths, resource names, object keys, API calls, state names.
- Use numbered steps for flows, at most 7 per diagram; beyond that, split phases or split the diagram. Use dashed arrows (`data-tone="muted"`) only when the surrounding prose or caption defines the meaning.
- Keep arrows quiet and semantic:
  - declare arrows with `data-from`/`data-to`; the router produces short rounded orthogonal paths — if a route looks forced, fix the layout or `data-mid`/`data-lane`, do not fall back to hand-drawn curves;
  - the step number lives inside the arrow's label chip (`data-step`); in dense areas use a bare step chip (no `data-label`) and explain the step in the caption;
  - when an arrow would have to span more than two zones, prefer information duplication instead: place a small badge/node in the target zone (e.g. `deployment_id ← pool 0`) with a muted arrow or plain text reference — a canvas-crossing line is almost always worse;
  - never use an arrow to connect parallel conclusions that do not have a real causal/control/data relationship.
- Bezier/freeform curves are not available in the anchored-arrow model on purpose; for SVG fallback diagrams, keep rounded orthogonal routing because it is easier to lint, reproduce, and revise.
- Avoid huge titles inside the image, decorative gradients, neon accents, slide-cover composition, fake dashboards, fake terminal output, and copied third-party layout.

## Quality Gate

Before considering a diagram done:

- source is editable or reproducible;
- HTML/CSS diagrams pass `npm run diagram:html:check -- <diagram.html>` and export with zero geometry-audit errors (no `--force`); programmatic SVG diagrams pass `npm run diagram:check -- <diagram.json>`;
- the exported PNG was visually inspected (image Read) and every label is fully readable — no chip, arrowhead, or line touches any glyph;
- every major label is verified;
- the diagram answers one concrete question;
- arrows encode real control/data/state direction;
- arrows do not cross node labels, visually detach from step circles, or require the reader to untangle decorative bends;
- parallel conclusions are placed as notes or sibling boxes, not chained by arrows;
- text is readable at mobile width;
- the source does not depend on remote CSS, icon fonts, CDN scripts, or private local paths;
- no third-party diagram, watermark, badge, or distinctive layout was copied;
- exported asset is referenced with meaningful alt text and a `Fig.` caption.
