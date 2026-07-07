# HTML/CSS Diagram Workflow

Use this reference when creating or revising diagrams with the default HTML/CSS path.

## Why HTML/CSS First

Use HTML/CSS for diagrams that are mostly layout, grouping, labels, repeated nodes, tables, layers, or topology. It avoids coordinate-heavy SVG work and lets the agent use modern layout primitives:

- CSS Grid for columns, layers, pool/node matrices, before/after panels, and fixed canvas structure.
- Flexbox for rows of processes, disks, shards, events, or state chips.
- CSS custom properties for color tokens, spacing, borders, and typography.
- Declarative anchored arrows (`.dg-arrow` with `data-from`/`data-to`) routed from real element positions at export time.
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
- `id`s on arrow endpoints plus `.dg-arrow` declarations (see Arrow Rules) — no SVG paths, no pixel coordinates.
- Small `data-diagram-css` blocks only for diagram-specific grid tracks and dimensions.
- Short comments only for repeated topology sections or non-obvious arrow declarations.
- No remote scripts, CDN CSS, web fonts, or private local paths.

## Template

Start from:

```bash
cp .agents/skills/blog-architecture-diagrams/assets/html-diagram-template.html \
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

Arrows are declared, not drawn. Give every arrow endpoint an `id` and add one declaration per arrow anywhere inside the canvas root:

```html
<div class="dg-arrow" data-from="init-storage" data-to="layout" data-label="read volumes" data-step="1"></div>
```

At build/export time a runtime measures the real rendered boxes with `getBoundingClientRect()`, routes a rounded orthogonal path between the two elements, renders a slim-headed SVG overlay, and places the label chip (with the step number merged into it) in collision-free whitespace. The exported `.built.html` contains the baked static SVG; no coordinates ever live in the source.

Attribute reference:

```text
data-from / data-to     required element ids
data-route              h | v | auto (default)
data-exit / data-enter  left|right|top|bottom edge override
data-exit-at/-enter-at  0..1 position along that edge (default 0.5)
data-mid                0..1 position of the middle segment (default 0.5)
data-lane               px offset for the middle segment (parallel arrows)
data-tone               "muted" = dashed gray secondary route
data-label              label chip text
data-step               step number, rendered inside the chip
data-label-at           0..1 label anchor along the path (default 0.5)
```

Rules:

- Never hand-write SVG paths or absolutely-positioned `.dg-step` circles; the geometry audit flags them and they rot as soon as layout shifts.
- At most 7 numbered steps per diagram.
- In dense areas, use a bare step chip (`data-step` without `data-label`) and explain the step in the caption.
- When an arrow would span more than two zones, duplicate the information instead: put a small badge in the target zone and reference it in prose or with a short muted arrow.
- Use `data-tone="muted"` only for secondary/indirect relationships defined in the caption.
- Never connect sibling conclusions with arrows.

## Export

First validate:

```bash
npm run diagram:html:check -- src/data/blog/<slug>-assets/<name>.diagram.html
```

Build explicitly when needed:

```bash
npm run diagram:html:build -- \
  src/data/blog/<slug>-assets/<name>.diagram.html \
  src/data/blog/<slug>-assets/<name>.built.html
```

Then export when a local browser is available:

```bash
npm run diagram:html:export -- \
  src/data/blog/<slug>-assets/<name>.diagram.html \
  src/data/blog/<slug>-assets/<name>.png
```

The export script builds `.built.html` automatically, runs the arrow runtime in headless Chrome, bakes the computed arrows into the built file, and runs a geometry audit before taking the screenshot. Audit errors (arrow through text, chip on a node, out-of-bounds route, step circle on a label) block the export; fix the source rather than reaching for `--force`. If no browser exists, open the built HTML manually — arrows render live from the declarations — and capture the fixed-size `dg-canvas`. Do not commit browser cache, temporary screenshots, or generated files outside the post assets folder.

After every export, open the PNG (image Read) and verify each label is fully readable before embedding it.

## Review Checklist

- The diagram has one concrete question and a visible answer.
- DOM structure matches ownership: zones contain real nodes, nodes contain real disks/files/processes.
- Labels are exact and verified, not invented for visual balance.
- The exported image is readable at mobile article width.
- No remote CSS/JS/font dependencies are required.
- The caption starts with `Fig.` and tells the reader what to notice.
