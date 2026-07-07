# Technical Visual Style

This guide tells agents how to choose, draw, place, and validate images for infrastructure posts.

Use it as this project's internal craft reference, not a clone target. Do not copy another author's diagrams, screenshots, watermark, captions, exact layout, or distinctive visual assets.

## Core Principle

In technical posts, an image is evidence or navigation.

Every image must answer at least one of these questions:

- What components exist?
- Who calls whom?
- Where does data or metadata go?
- Which path, file, API, or object is being discussed?
- What changed before and after this command?
- Which log, metric, UI state, or source line proves the claim?

If an image only makes the post look nicer, remove it.

## Image Types

Use these image types intentionally.

| Type | Use When | Must Show | Avoid |
| --- | --- | --- | --- |
| Orientation diagram | The reader needs a map before details | Components, boundaries, one main scenario | Decorative architecture blobs |
| Workflow diagram | The article follows a request/event path | Numbered steps, arrows, actors, sync/async distinction | Unlabeled arrows |
| Layer diagram | Explaining storage, networking, runtime, scheduler, compiler layers | User view, control plane, data plane, persistence layer | Mixing unrelated abstractions |
| State-change diagram | A command changes files, objects, memory, metadata, or resources | Before/after state and the operation between them | A screenshot without interpretation |
| Evidence screenshot | UI/log/metric/output is itself proof | Cropped relevant area, redacted secrets, visible key value | Full desktop screenshots |
| Code/source excerpt image | Only when typography or annotation matters | Function/interface name, file/version, highlighted line | Screenshots of code that could be a code block |

## Visual Plan Template

Before drafting a long technical post, fill out this table. If a row cannot name a purpose, remove the image. If a major section has no image or other evidence anchor, reconsider the section.

| Section | Image | Purpose | Type | Required Labels | Source | Caption | Alt Text |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Opening | Main orientation diagram | Give readers the whole system map | Diagram | Components, boundaries, main path | Drawn from verified topology | `Fig. ...` | Describes the full map |
| Step section | Current workflow step | Show who calls whom or where data moves | Diagram/crop | Step number, API/path/object names | Editable diagram | `Fig. ...` | Describes the step |
| Evidence section | Real output | Prove a measured or observed claim | Screenshot/terminal | Command, value, object/file/path | Captured output | `Fig. ...` | Describes the observed result |

For a storage or distributed-systems post, the minimum useful image set is usually:

- main topology/workflow diagram;
- disk/object layout evidence;
- key metadata/source evidence;
- data placement or shard/failure-domain diagram;
- final mental-model diagram, often a simplified reuse of the opening diagram.

## Diagram Style

For systems diagrams:

- Use a large canvas, usually 16:9 or wider: `1600x900`, `1800x1000`, or similar.
- Prefer a plain dark or white background. Dark backgrounds work well for dense infrastructure maps; white backgrounds work well for screenshots and simple flows.
- Keep the palette small:
  - light blue for pods, services, or control-plane components;
  - light green for agents, clients, plugins, or sidecars;
  - pale yellow/orange for files, volumes, buckets, objects, or persisted state;
  - gray for kernel, host, shared substrate, queues, or neutral zones;
  - one accent blue for highlighted paths, external paths, or current step.
- Use simple geometric blocks with labels. Rounded corners are fine but should not become decorative.
- Use arrows to encode direction. Dashed arrows can mean async, indirect, callback, or mount/bind relation, but define that meaning in the caption or nearby prose.
- Use numbered circles for step-by-step flows.
- Put concrete labels in the diagram: `NodePublishVolume()`, `PreFilter`, `binding cycle`, `/var/lib/kubelet/.../mount`, `juicefs_uuid`, `object store`.
- Prefer a few large labels over many tiny labels. The image must remain readable on mobile after scaling.
- Use icons sparingly and only when they reduce cognitive load. Folder, pod, bucket, database, and node icons are useful; decorative illustrations are not.
- Do not add personal watermarks. If attribution is needed, put it in the caption or `参考资料`.

### Engineering Diagram Look

The target look is a plain manually composed engineering diagram, not a modern product infographic.

Prefer:

- no large title inside the image; let the article title and `Fig.` caption do that work;
- modest text hierarchy: component labels slightly larger, detail labels smaller, no hero typography;
- sparse labels that name real components, files, paths, functions, objects, or states;
- simple rectangles, grouped zones, arrows, dashed lines, folder/disk/node icons, and small step numbers;
- visible topology: nodes, disks, buckets, sets, queues, pods, or host boundaries should look like the actual system structure;
- wide whitespace and a few well-placed objects instead of a balanced poster layout;
- flat colors with thin outlines; avoid gradients, shadows, glow, and highly saturated accent colors;
- exported PNG/SVG from an editable source such as SVG, Mermaid, Excalidraw, draw.io, Google Drawings/Slides-style canvas, or a small rendering script.

Avoid:

- slide-cover style diagrams with a huge title and subtitle embedded in the image;
- card UI layout where every concept becomes a polished rounded card;
- neon-blue/orange product colors that dominate the figure;
- oversized bold sans-serif text that feels like a dashboard hero;
- arrows that are decorative rather than semantic;
- step bubbles that float on top of arrows without clarifying the actual call/data path;
- flattening topology into abstract cards when the article needs readers to see machines, disks, files, or shards.

If a diagram starts to look like a SaaS explainer slide, simplify it: remove the title, reduce font sizes, use fewer colors, replace cards with system shapes, and make the real topology visible.

## Placement

- Put the main orientation diagram near the top of long systems posts.
- Reuse the same main diagram later when stepping through the flow, but crop or annotate the current region if possible.
- Place each screenshot directly after the paragraph that raises the claim it proves.
- Use screenshots as local proof, not as an appendix. The reader should never need to scroll far away from a claim to see its evidence.
- Put a caption immediately after every image. Start with `Fig.` and describe the scenario:

```markdown
![JuiceFS CSI creates a client pod and bind mounts the volume into a business pod](./assets/juicefs-csi-workflow.png)
Fig. JuiceFS CSI mount-pod mode: a business pod uses a PV through a per-PV client pod and host bind mounts.
```

## Screenshot Evidence Blocks

Use this structure when a screenshot proves a claim:

````markdown
这里要验证的是：`format.json` 不是单点文件，而是每块盘都有一份；其中 `sets` 相同，但 `this` 不同。

```bash
for d in node*/disk*; do
  jq '{id, this: .xl.this, sets: .xl.sets}' "$d/.rustfs.sys/format.json"
done
```

![Eight RustFS disks show the same deployment id and sets but different this UUID values](./assets/format-json-per-disk.png)
Fig. Each disk has its own `format.json`; `this` identifies the current disk while `sets` records the pool layout.

注意截图里同一个 set 布局重复出现，但每块盘的 `this` 不一样。
````

The order matters:

1. Claim: say exactly what the screenshot will prove.
2. Operation: show the command, UI action, request, or source location that produced it.
3. Screenshot: crop to the relevant output or UI region.
4. Caption: describe the scenario, not the file name.
5. Interpretation: point to the line, value, count, or visual region that matters.

Do not put screenshots in a gallery at the end. Do not ask readers to infer why a screenshot exists.

Do not alter screenshot contents for readability except by redacting or cropping. If a long JSON/log/source block is summarized in a diagram or caption, call it a summary and do not use invented field names that look like real output.

### When Screenshots Are Mandatory

Use a screenshot, terminal render, or source excerpt when the post relies on:

- real command output, including `tree`, `find`, `du`, `stat`, `jq`, `kubectl`, `docker logs`, `journalctl`, or compiler diagnostics;
- UI/object-store state, such as bucket contents, uploaded objects, dashboard metrics, or admin panels;
- log lines where ordering, timestamp, error code, or component name matters;
- measured values, such as file sizes, shard counts, memory, latency, throughput, or object counts;
- source-code evidence where the exact function/interface/comment is the proof;
- before/after state after a command, startup, upload, failure, repair, or migration.

If the evidence is short and purely textual, a code block may be enough. If the claim depends on "I actually ran/saw this", prefer a terminal screenshot rendered from captured output.

## Manual Diagram Workflow

Final technical diagrams should be hand-built from verified facts in an editable format, then exported. Do not use AI-generated bitmap diagrams as the default.

Preferred order:

1. Create an editable diagram first: programmatic SVG, handwritten SVG/HTML/CSS, Excalidraw, draw.io, Google Slides/Drawings-style canvas, or a small script that renders a diagram.
2. Export the final display asset as PNG or SVG.
3. Keep the editable source next to the exported image when practical, for example under `src/data/blog/<slug>-assets/`.
4. Use source-backed screenshots for real UI, logs, object-store state, metrics, and terminal output.
5. Use AI image generation only as a rough layout sketch for a diagram without exact labels, then recreate the final image manually in an editable tool.

Never ask an image model for a generic "beautiful technology illustration". For final diagrams, exact labels, paths, arrows, and component boundaries matter more than painterly polish.

### Project Diagram Skill

When an AI agent needs to create or revise a serious architecture/workflow/topology/state-change diagram, use the project skill at `.agents/skills/blog-architecture-diagrams/` (also reachable via the `.claude/skills/` and `.codex/skills/` symlinks, so it works in Claude Code, Codex, and other agents).

That skill provides a JSON-to-SVG renderer:

```bash
npm run diagram:check -- src/data/blog/<slug>-assets/<name>.diagram.json
npm run diagram:render -- \
  src/data/blog/<slug>-assets/<name>.diagram.json \
  src/data/blog/<slug>-assets/<name>.svg
```

Use it when the diagram needs explicit zones, numbered arrows, storage layouts, host/pod/disk topology, repeated visual vocabulary, or mobile-readable labels. If `diagram:check` fails, fix the JSON layout before rendering or embedding the image.

### Mermaid Boundary

Mermaid is only a lightweight draft tool for simple linear flows or small sequence diagrams. Do not use Mermaid as the final format for complex systems diagrams when the post needs precise layout, ownership boundaries, storage topology, before/after state, cropped variants, or non-overlapping labels.

If a Mermaid diagram starts accumulating layout hacks, replace it with programmatic SVG or handwritten SVG/HTML/CSS.

### Arrow QA

Before accepting a generated diagram, inspect arrows first. Reject or revise the diagram when:

- an arrow crosses through component text;
- an arrow label sits on top of a busy line or junction;
- a step number overlaps a node border, arrowhead, or label;
- a step number is visually detached from the arrow it numbers;
- a dashed secondary path visually dominates the primary path;
- arrowheads are so large that they hide the target;
- a path takes a decorative detour instead of following a readable lane.

Prefer rounded orthogonal paths for the project SVG renderer. A sharp polyline usually means the route is unresolved, not that the diagram needs Bezier curves. Use Bezier/freeform curves only when the validator and surrounding diagram contract can still prove non-overlap, direction, and label placement.

Do not use arrows to connect parallel conclusions. For example, a capacity formula and a failure-tolerance rule may sit near the same topology, but an arrow between them implies causality. Use arrows for real control flow, data flow, state change, or recovery direction; use adjacent notes or parallel boxes for interpretation.

When one semantic path spans multiple arrows, keep the visual style consistent: same color, width, dash pattern, and step placement convention. Use saturation and dash style to separate primary paths from metadata reloads, background healing, or secondary checks.

### Hand-Drawn Diagram Checklist

Before exporting:

- [ ] The source is editable or reproducible.
- [ ] All labels are manually verified against the article, commands, source code, or screenshots.
- [ ] The canvas is wide enough for the flow, usually 16:9 or wider.
- [ ] Related entities use consistent colors across the article.
- [ ] The exported PNG/SVG is readable at mobile width.
- [ ] The exported asset has no external watermark, author imitation, or decorative filler.

### Prompt Template For AI Layout Drafts

Use this only for rough layout exploration, then rebuild the final diagram manually:

```text
Create a clean technical architecture diagram for a Chinese infrastructure blog post.

Canvas: 16:9 wide diagram, plain dark background, high contrast, readable labels.
Style: simple boxes, muted pastel colors, thin arrows, numbered step circles, no decorative background, no photorealistic elements.

Scenario:
<one sentence describing the concrete operation, for example: Kubernetes creates a business Pod that uses a JuiceFS PVC in mount-pod mode>

Components:
- <component 1 and role>
- <component 2 and role>
- <component 3 and role>

Flow:
1. <first event>
2. <second event>
3. <third event>

Important labels that must be present:
- `<exact API/function/path/resource name>`
- `<exact API/function/path/resource name>`

Visual emphasis:
- Highlight the current path in blue.
- Show persisted files/objects in pale yellow.
- Show client/agent/plugin components in light green.
- Show pods/control plane components in light blue.

Do not add logos, watermarks, fake text, fake code, fake dashboards, or unrelated decorative icons.
```

If the generated image contains garbled labels or invented details, do not use it as-is. Rebuild it in an editable diagram tool or simplify the labels.

## Screenshot Rules

- Capture only what proves the point.
- Crop aggressively.
- Redact tokens, emails, bucket account IDs, internal domains, local paths, and private company data.
- Do not publish screenshots of private chat, internal dashboards, or sensitive account UI.
- Prefer PNG for diagrams and UI screenshots; use JPEG only for large photographic screenshots where compression is acceptable.
- For terminal output, prefer `scripts/render-terminal-screenshot.js` so styling stays consistent.

## Caption And Alt Text

Alt text should describe the information in the image, not say "screenshot" or "diagram".

Good:

```markdown
![Scheduler extension points from PreEnqueue through PostBind, split into scheduling cycle and binding cycle](./assets/scheduler-framework.png)
Fig. Kubernetes scheduler framework extension points, grouped by scheduling cycle and binding cycle.
```

Bad:

```markdown
![image](./assets/diagram.png)
Fig. diagram.
```

## Visual QA Checklist

- [ ] The image answers a concrete question in the surrounding section.
- [ ] Labels are exact and readable at mobile width.
- [ ] Arrows have clear direction and meaning.
- [ ] Step circles sit on or immediately beside their arrow paths and do not cover labels.
- [ ] Arrows do not imply causality between parallel conclusions.
- [ ] Color is used consistently across the article.
- [ ] Caption starts with `Fig.` and explains the scenario.
- [ ] Alt text is meaningful.
- [ ] No copied third-party diagram, watermark, badge, or screenshot is used without permission.
- [ ] No fake command output, fake logs, fake metrics, or fake UI state.
- [ ] No secrets or private information are visible.
- [ ] Local images are uploaded before release.
