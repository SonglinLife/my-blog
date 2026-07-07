# Diagram Style Reference

This reference captures the preferred visual language for architecture diagrams in this blog. It is inspired by plain engineering diagrams: explicit topology, readable labels, wide canvases, and a small color vocabulary. It is not a license to copy another author's figures, captions, exact layout, labels, or visual assets.

## What To Optimize For

Optimize for explanation, not decoration.

Good diagrams make these relationships visible:

- component ownership: process, pod, node, disk, bucket, metadata engine, client, control plane;
- boundaries: host, cluster, volume, storage layer, runtime layer, persistence layer;
- direction: call path, data path, metadata path, recovery path, async path;
- state: before/after, primary/secondary, healthy/failed, old/new location;
- evidence labels: function names, commands, files, resource names, keys, log fields, source symbols.

## Composition Patterns

Use these patterns for complex technical posts:

- **Left-to-right request path**: client/user on the left, control plane or metadata engine in the middle, storage/object layer on the right.
- **Top-to-bottom layer stack**: API/user view, runtime/client layer, metadata layer, persistence/object layer.
- **Cluster topology**: large cluster zone containing node zones; nodes contain pods/processes/disks.
- **Before/after state**: two balanced panels with a narrow operation arrow between them.
- **Zoomed evidence inset**: a small file/object/key box near the component that writes or reads it.

Prefer natural topology over symmetrical poster balance. If the system has three nodes and eight disks, show that structure; do not flatten it into three equal marketing cards.

## Shape Vocabulary

- Zone: large lightly tinted rectangle with a label in the top-left.
- Component: modest rectangle with 4-8 px corner radius.
- Database/metadata engine: cylinder-like shape only when it clarifies persistence.
- Disk/object/file: pale yellow rectangle, bucket, folder, or stacked blocks.
- Step: small numbered circle near the arrow start or bend.
- Note: small low-contrast callout for caveats or invariants, never a substitute for prose.

## Arrow Design

Arrows should feel like wiring on an engineering drawing, not motion graphics.

Before rendering, reserve arrow lanes:

- horizontal lanes between rows of nodes;
- vertical lanes between zones;
- bottom or side lanes for recovery/failure paths;
- separate lanes for primary flow and secondary/failure flow.

Rules:

- Keep primary flow arrows short and mostly left-to-right or top-to-bottom.
- In the HTML/CSS workflow, declare arrows (`data-from`/`data-to`) and let the router produce rounded orthogonal paths; never hand-write coordinates.
- Use small arrowheads. Huge heads imply emphasis and can hide the real target.
- Labels live in whitespace next to the arrow, with the step number inside the label chip. At most 7 steps per diagram; in dense areas use a bare step chip and explain it in the caption.
- Dashed arrows are secondary. Make them thinner or gray unless the failure/recovery path is the main subject.
- Do not chain sibling conclusions with arrows. A capacity formula, a tolerance rule, and an operational caveat can be visually grouped, but an arrow between them should mean a real state/control/data transition.
- Do not reach for Bezier curves to fix awkward routing. First fix lanes, node placement, and `data-mid`/`data-lane`. If a route still fights the layout, the layout is wrong.
- When an arrow would have to span more than two zones, duplicate the information instead: place a small badge/node in the target zone (e.g. `deployment_id ← pool 0`) and reference it in prose or with a short muted arrow. A canvas-crossing line is almost always the worse diagram.

If an arrow must cross a zone, it should cross empty space inside that zone. If it crosses a node label, the geometry audit will reject the export — change the lane or the layout, not the audit.

## Color Vocabulary

Keep colors muted and consistent across a post:

```text
blue    control plane, pod, service, API component
green   client, agent, sidecar, plugin, local process
yellow  file, disk, object, bucket, persistent metadata
gray    host, kernel, queue, neutral substrate, boundary
red     failure, deletion, rejected path; use sparingly
accent  current path, selected step, active arrow
```

Avoid one-color diagrams. Avoid gradients, glow, heavy shadow, product-infographic polish, and large decorative titles inside the image.

## Mermaid Boundary

Mermaid is useful for:

- quick outline drafts;
- tiny flowcharts;
- simple sequence diagrams;
- throwaway planning notes.

Mermaid is usually too weak for final systems diagrams when the post needs:

- exact placement of zones, disks, buckets, or hosts;
- multiple arrow types with labels that must not overlap;
- cropped/zoomed variants of the same base diagram;
- mobile-readable typography;
- visual grouping by ownership or failure domain;
- storage layouts, metadata schemas, topology, or before/after state.

When Mermaid feels limiting, switch to the HTML/CSS diagram workflow immediately instead of spending time fighting the renderer. Use programmatic SVG only when geometry lint or a narrow edit to an existing JSON diagram is the better tradeoff.

## Label Discipline

Labels must be exact enough to be useful:

- prefer `NodePublishVolume()`, `juicefs dump`, `/var/lib/kubelet/.../mount`, `format.json`, `pool.bin`;
- avoid vague labels like `process`, `metadata`, `storage`, `system`;
- if a label is a simplification, make it visually secondary and explain the exact term in prose.

Do not invent CLI output, JSON fields, log lines, metrics, source names, or object keys for diagram cleanliness.

## Review Pass

After rendering, inspect the image as a reader:

- Can I understand the system question without reading five paragraphs?
- Can I follow the numbered path in order?
- Are ownership boundaries visible?
- Are arrows semantic, or just decorative?
- Do any arrows cut through component text, captions, or step markers?
- Is any label too small on a phone?
- Does the caption explain the scenario rather than repeat the filename?
