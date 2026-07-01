# HTML/CSS Diagram Workflow

Use this reference when creating or revising diagrams with the default HTML/CSS path.

## Why HTML/CSS First

Use HTML/CSS for diagrams that are mostly layout, grouping, labels, repeated nodes, tables, layers, or topology. It avoids coordinate-heavy SVG work and lets the agent use modern layout primitives:

- CSS Grid for columns, layers, pool/node matrices, before/after panels, and fixed canvas structure.
- Flexbox for rows of processes, disks, shards, events, or state chips.
- CSS custom properties for color tokens, spacing, borders, and typography.
- Inline SVG overlays for arrows, brackets, routes, and small topology connectors.
- `data-*` attributes and semantic class names so future edits can target the right component.
- Use the local Tailwind-backed diagram kit in `assets/diagram-kit.css` by default. It provides stable `dg-*` component classes while keeping the final built file self-contained. Never depend on CDN styles.

Keep the final look plain and engineering-focused. HTML/CSS is a layout engine here, not permission to create a SaaS landing graphic.

## Source And Export Files

For each diagram, prefer:

```text
src/data/blog/<slug>-assets/<name>.diagram.html
src/data/blog/<slug>-assets/<name>.png
```

Use a single editable HTML source that links to the local diagram kit. The export script will compile Tailwind and inline the CSS into a self-contained `.built.html`. The source should include:

- `<main class="diagram" data-diagram-root ...>` as the fixed canvas root.
- `aria-label` describing the diagram.
- `dg-*` component classes for common visual vocabulary.
- Small `data-diagram-css` blocks only for diagram-specific grid tracks, dimensions, and arrow coordinates.
- Short comments only for complex arrow overlays or repeated topology sections.
- No remote scripts, CDN CSS, web fonts, or private local paths.

## Template

Start from:

```bash
cp .codex/skills/blog-architecture-diagrams/assets/html-diagram-template.html \
  src/data/blog/<slug>-assets/<name>.diagram.html
```

Then replace placeholder labels, zones, and arrows with verified labels from the article, commands, source code, or screenshots.

## CSS Conventions

Use these diagram kit classes unless the diagram needs a clearer local extension:

```text
dg-canvas       fixed-size canvas
dg-zone-*       large ownership/layer boundary
dg-node-*       concrete component/process/API/file/disk
dg-pool-*       nested pool/topology group
dg-step         numbered step marker
dg-label        small route label
dg-note         compact caveat/invariant callout
dg-arrows       absolute inline SVG overlay
dg-legend       color legend
```

Prefer `box-sizing: border-box`, fixed canvas dimensions, and explicit row/column sizing. Avoid fluid text scaling; instead choose a canvas wide enough for the diagram and keep labels short.

## Layout Patterns

- **Workflow:** `.diagram` as a 3-column grid; each column is a `.zone`; arrows run in a full-canvas `.arrows` overlay.
- **Cluster topology:** outer cluster `.zone`; nested CSS Grid for nodes; each node contains disk/file components.
- **Layer stack:** vertical CSS Grid rows for API, runtime, metadata, persistence; arrows mostly top-to-bottom.
- **Before/after:** two equal panels with a narrow operation lane between them.
- **Evidence inset:** a small `.node--yellow` file/object box near the component that writes or reads it.

## Arrow Rules

Use inline SVG for arrows because it is still the most reliable way to draw routed connectors on top of a DOM layout. Keep all arrow labels in HTML nodes when possible; use SVG text only for short route labels that are easier to position with the path.

Requirements:

- Define arrow lanes before drawing.
- Keep routes orthogonal or gently curved.
- Do not cross component text.
- Put `.step` circles on or very near the path.
- Use dashed gray routes only for secondary/indirect relationships.
- Never connect sibling conclusions with arrows.

## Export

First validate:

```bash
node .codex/skills/blog-architecture-diagrams/scripts/validate-html-diagram.js \
  src/data/blog/<slug>-assets/<name>.diagram.html
```

Build explicitly when needed:

```bash
node .codex/skills/blog-architecture-diagrams/scripts/build-html-diagram.js \
  src/data/blog/<slug>-assets/<name>.diagram.html \
  src/data/blog/<slug>-assets/<name>.built.html
```

Then export when a local browser is available:

```bash
node .codex/skills/blog-architecture-diagrams/scripts/export-html-diagram.js \
  src/data/blog/<slug>-assets/<name>.diagram.html \
  src/data/blog/<slug>-assets/<name>.png
```

The export script builds `.built.html` automatically, then looks for Chrome/Chromium. If no browser exists, open the built HTML manually and capture the fixed-size `dg-canvas`. Do not commit browser cache, temporary screenshots, or generated files outside the post assets folder.

## Review Checklist

- The diagram has one concrete question and a visible answer.
- DOM structure matches ownership: zones contain real nodes, nodes contain real disks/files/processes.
- Labels are exact and verified, not invented for visual balance.
- The exported image is readable at mobile article width.
- No remote CSS/JS/font dependencies are required.
- The caption starts with `Fig.` and tells the reader what to notice.
