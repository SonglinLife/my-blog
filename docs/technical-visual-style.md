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

## Placement

- Put the main orientation diagram near the top of long systems posts.
- Reuse the same main diagram later when stepping through the flow, but crop or annotate the current region if possible.
- Place each screenshot directly after the paragraph that raises the claim it proves.
- Put a caption immediately after every image. Start with `Fig.` and describe the scenario:

```markdown
![JuiceFS CSI creates a client pod and bind mounts the volume into a business pod](./assets/juicefs-csi-workflow.png)
Fig. JuiceFS CSI mount-pod mode: a business pod uses a PV through a per-PV client pod and host bind mounts.
```

## AI Drawing Workflow

Use generative image tools carefully. They are good for layout drafts and simple non-exact diagrams, but bad at exact text, paths, API names, and source code.

Preferred order:

1. Use source-backed screenshots for real UI, logs, object-store state, metrics, and terminal output.
2. Use Mermaid, SVG, Excalidraw, draw.io, or another editable diagram format when labels must be exact.
3. Use AI image generation only for a technical diagram draft, then inspect and correct labels manually.

Never ask an image model for a generic "beautiful technology illustration". Ask for a specific technical diagram with named components, arrows, and visual hierarchy.

### Prompt Template For Diagram Drafts

Use a prompt like this, then verify every label:

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
- [ ] Color is used consistently across the article.
- [ ] Caption starts with `Fig.` and explains the scenario.
- [ ] Alt text is meaningful.
- [ ] No copied third-party diagram, watermark, badge, or screenshot is used without permission.
- [ ] No fake command output, fake logs, fake metrics, or fake UI state.
- [ ] No secrets or private information are visible.
- [ ] Local images are uploaded before release.
