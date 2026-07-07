#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error("Usage: node render-architecture-svg.js <diagram.json> <output.svg>");
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(inputPath, "utf8"));

const width = spec.width ?? 1600;
const height = spec.height ?? 900;
const bg = spec.background ?? "#fbfbf7";
const title = spec.title ?? "";

const tones = {
  blue: { fill: "#dbeafe", stroke: "#2563eb", text: "#0f172a" },
  green: { fill: "#dcfce7", stroke: "#16a34a", text: "#0f172a" },
  yellow: { fill: "#fef3c7", stroke: "#d97706", text: "#0f172a" },
  orange: { fill: "#ffedd5", stroke: "#ea580c", text: "#0f172a" },
  gray: { fill: "#e5e7eb", stroke: "#6b7280", text: "#111827" },
  red: { fill: "#fee2e2", stroke: "#dc2626", text: "#111827" },
  white: { fill: "#ffffff", stroke: "#9ca3af", text: "#111827" },
  dark: { fill: "#1f2937", stroke: "#64748b", text: "#f8fafc" },
};

const accent = spec.accent ?? "#2563eb";
const nodes = new Map();

for (const item of spec.nodes ?? []) {
  nodes.set(item.id, item);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tone(name = "white") {
  return tones[name] ?? tones.white;
}

function attrs(obj) {
  return Object.entries(obj)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => `${key}="${esc(value)}"`)
    .join(" ");
}

function textLines(text) {
  return String(text ?? "").split(/\n/);
}

function multilineText(text, x, y, options = {}) {
  const lines = textLines(text);
  const size = options.size ?? 28;
  const color = options.color ?? "#111827";
  const weight = options.weight ?? 500;
  const anchor = options.anchor ?? "middle";
  const lineHeight = options.lineHeight ?? Math.round(size * 1.25);
  const startY = y - ((lines.length - 1) * lineHeight) / 2;

  return `<text ${attrs({
    x,
    y: startY,
    "text-anchor": anchor,
    "font-size": size,
    "font-weight": weight,
    fill: color,
  })}>${lines
    .map((line, index) => `<tspan x="${esc(x)}" dy="${index === 0 ? 0 : lineHeight}">${esc(line)}</tspan>`)
    .join("")}</text>`;
}

function wrapText(text, maxChars = 56) {
  const raw = String(text ?? "");
  const lines = [];
  for (const paragraph of raw.split(/\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (next.length > maxChars && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [raw];
}

function center(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function edgePoint(box, toward) {
  const c = center(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const scaleX = dx === 0 ? Infinity : Math.abs((box.w / 2) / dx);
  const scaleY = dy === 0 ? Infinity : Math.abs((box.h / 2) / dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

function moveToward(point, toward, distance) {
  const dx = toward.x - point.x;
  const dy = toward.y - point.y;
  const length = Math.hypot(dx, dy);
  if (!length) return point;
  return {
    x: point.x + (dx / length) * distance,
    y: point.y + (dy / length) * distance,
  };
}

function pointAlong(start, end, distance, offset = 0) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (!length) return start;
  const ux = dx / length;
  const uy = dy / length;
  return {
    x: start.x + ux * distance - uy * offset,
    y: start.y + uy * distance + ux * offset,
  };
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function pointToward(point, toward, amount) {
  const length = distance(point, toward);
  if (!length) return point;
  return {
    x: point.x + ((toward.x - point.x) / length) * amount,
    y: point.y + ((toward.y - point.y) / length) * amount,
  };
}

function roundedPath(points, radius = 14) {
  if (points.length < 3 || radius <= 0) {
    return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  }

  const commands = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const current = points[i];
    const next = points[i + 1];
    const prevLen = distance(prev, current);
    const nextLen = distance(current, next);
    const bend = Math.min(radius, prevLen / 2, nextLen / 2);

    if (bend <= 0) {
      commands.push(`L ${current.x} ${current.y}`);
      continue;
    }

    const before = pointToward(current, prev, bend);
    const after = pointToward(current, next, bend);
    commands.push(`L ${before.x} ${before.y}`);
    commands.push(`Q ${current.x} ${current.y} ${after.x} ${after.y}`);
  }
  const last = points.at(-1);
  commands.push(`L ${last.x} ${last.y}`);
  return commands.join(" ");
}

function nodeBox(idOrPoint) {
  if (typeof idOrPoint === "string") {
    const item = nodes.get(idOrPoint);
    if (!item) throw new Error(`Unknown node id in arrow: ${idOrPoint}`);
    return item;
  }
  return { x: idOrPoint.x, y: idOrPoint.y, w: 1, h: 1 };
}

function renderZone(zone) {
  const palette = tone(zone.tone ?? "gray");
  return `<g class="zone">
    <rect ${attrs({
      x: zone.x,
      y: zone.y,
      width: zone.w,
      height: zone.h,
      rx: zone.rx ?? 10,
      fill: zone.fill ?? palette.fill,
      stroke: zone.stroke ?? palette.stroke,
      "stroke-width": zone.strokeWidth ?? 2,
      "stroke-dasharray": zone.dashed ? "9 8" : undefined,
      opacity: zone.opacity ?? 0.45,
    })}/>
    ${zone.label ? multilineText(zone.label, zone.x + 24, zone.y + 38, {
      anchor: "start",
      size: zone.labelSize ?? 25,
      weight: 700,
      color: zone.labelColor ?? palette.text,
    }) : ""}
  </g>`;
}

function renderDatabase(item, palette) {
  const rx = item.w / 2;
  const topH = Math.min(34, item.h * 0.28);
  return `<g class="node database">
    <path ${attrs({
      d: `M ${item.x} ${item.y + topH / 2}
          C ${item.x} ${item.y - topH / 2}, ${item.x + item.w} ${item.y - topH / 2}, ${item.x + item.w} ${item.y + topH / 2}
          L ${item.x + item.w} ${item.y + item.h - topH / 2}
          C ${item.x + item.w} ${item.y + item.h + topH / 2}, ${item.x} ${item.y + item.h + topH / 2}, ${item.x} ${item.y + item.h - topH / 2}
          Z`,
      fill: item.fill ?? palette.fill,
      stroke: item.stroke ?? palette.stroke,
      "stroke-width": item.strokeWidth ?? 3,
    })}/>
    <ellipse ${attrs({
      cx: item.x + rx,
      cy: item.y + topH / 2,
      rx,
      ry: topH / 2,
      fill: item.fill ?? palette.fill,
      stroke: item.stroke ?? palette.stroke,
      "stroke-width": item.strokeWidth ?? 3,
    })}/>
    ${multilineText(item.label, item.x + item.w / 2, item.y + item.h / 2 + 8, {
      size: item.fontSize ?? 25,
      weight: item.fontWeight ?? 650,
      color: item.textColor ?? palette.text,
    })}
  </g>`;
}

function renderNode(item) {
  const palette = tone(item.tone);
  if (item.shape === "database") return renderDatabase(item, palette);

  return `<g class="node">
    <rect ${attrs({
      x: item.x,
      y: item.y,
      width: item.w,
      height: item.h,
      rx: item.rx ?? 8,
      fill: item.fill ?? palette.fill,
      stroke: item.stroke ?? palette.stroke,
      "stroke-width": item.strokeWidth ?? 3,
      "stroke-dasharray": item.dashed ? "9 8" : undefined,
    })}/>
    ${multilineText(item.label, item.x + item.w / 2, item.y + item.h / 2, {
      size: item.fontSize ?? 25,
      weight: item.fontWeight ?? 650,
      color: item.textColor ?? palette.text,
    })}
  </g>`;
}

function arrowStroke(arrow) {
  return arrow.color ?? (arrow.dashed ? spec.dashedAccent ?? "#64748b" : accent);
}

function markerId(index) {
  return `arrow-head-${index}`;
}

function renderMarkerDefs(arrows) {
  return arrows
    .map((arrow, index) => arrow.marker === false ? "" : `<marker id="${markerId(index)}" viewBox="0 0 14 14" refX="12" refY="7" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
      <path d="M 2 2 L 12 7 L 2 12 z" fill="${esc(arrowStroke(arrow))}"/>
    </marker>`)
    .join("\n");
}

function arrowGeometry(arrow, index) {
  const fromBox = nodeBox(arrow.from);
  const toBox = nodeBox(arrow.to);
  const fromCenter = center(fromBox);
  const toCenter = center(toBox);
  let start = typeof arrow.from === "string" ? edgePoint(fromBox, arrow.points?.[0] ?? toCenter) : { x: arrow.from.x, y: arrow.from.y };
  let end = typeof arrow.to === "string" ? edgePoint(toBox, arrow.points?.at(-1) ?? fromCenter) : { x: arrow.to.x, y: arrow.to.y };
  const middle = arrow.points ?? [];
  const rawPoints = [start, ...middle, end];
  if (typeof arrow.from === "string" && rawPoints[1]) {
    start = moveToward(start, rawPoints[1], arrow.startGap ?? spec.defaultStartGap ?? 12);
  }
  if (typeof arrow.to === "string" && rawPoints.at(-2)) {
    end = moveToward(end, rawPoints.at(-2), arrow.endGap ?? spec.defaultEndGap ?? 18);
  }
  const points = [start, ...middle, end];
  const d = arrow.curve === false ? roundedPath(points, 0) : roundedPath(points, arrow.bendRadius ?? spec.defaultBendRadius ?? 14);
  const stroke = arrowStroke(arrow);
  const marker = arrow.marker === false ? undefined : `url(#${markerId(index)})`;
  const mid = points[Math.floor((points.length - 1) / 2)];
  const next = points[Math.min(points.length - 1, Math.floor((points.length - 1) / 2) + 1)];
  const labelX = arrow.labelX ?? (mid.x + next.x) / 2;
  const labelY = arrow.labelY ?? (mid.y + next.y) / 2 - 16;
  return { points, d, stroke, marker, labelX, labelY };
}

function renderArrowPath(arrow, index) {
  const geometry = arrowGeometry(arrow, index);
  return `<g class="arrow">
    <path ${attrs({
      d: geometry.d,
      fill: "none",
      stroke: geometry.stroke,
      "stroke-width": arrow.width ?? 3,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "stroke-dasharray": arrow.dashed ? arrow.dashArray ?? "9 8" : undefined,
      "marker-end": geometry.marker,
    })}/>
  </g>`;
}

function renderArrowOverlay(arrow, index) {
  const geometry = arrowGeometry(arrow, index);
  const [start, next] = geometry.points;
  const stepPoint = arrow.stepAt
    ? { x: arrow.stepAt.x, y: arrow.stepAt.y }
    : next
      ? pointAlong(start, next, arrow.stepDistance ?? 38, arrow.stepOffset ?? 0)
      : start;
  const labelLines = textLines(arrow.label ?? "");
  const labelWidth = arrow.labelWidth ?? 150;
  const labelHeight = arrow.labelHeight ?? Math.max(34, labelLines.length * (arrow.labelLineHeight ?? 24) + 14);

  return `<g class="arrow-overlay">
    ${arrow.step ? `<circle ${attrs({ cx: stepPoint.x + (arrow.stepX ?? 0), cy: stepPoint.y + (arrow.stepY ?? 0), r: arrow.stepRadius ?? 19, fill: geometry.stroke, stroke: "#ffffff", "stroke-width": 4 })}/><text ${attrs({ x: stepPoint.x + (arrow.stepX ?? 0), y: stepPoint.y + 7 + (arrow.stepY ?? 0), "text-anchor": "middle", "font-size": arrow.stepFontSize ?? 21, "font-weight": 800, fill: "#ffffff" })}>${esc(arrow.step)}</text>` : ""}
    ${arrow.label ? `<rect ${attrs({ x: geometry.labelX - labelWidth / 2, y: geometry.labelY - labelHeight / 2, width: labelWidth, height: labelHeight, rx: 5, fill: arrow.labelFill ?? bg, stroke: arrow.labelStroke ?? "none", opacity: arrow.labelOpacity ?? 0.94 })}/>${multilineText(arrow.label, geometry.labelX, geometry.labelY, { size: arrow.labelSize ?? 19, weight: 650, lineHeight: arrow.labelLineHeight ?? 24, color: arrow.labelColor ?? "#1f2937" })}` : ""}
  </g>`;
}

function renderNote(note) {
  const lines = wrapText(note.text, note.maxChars ?? 64);
  const lineHeight = note.lineHeight ?? 26;
  const h = note.h ?? Math.max(58, 28 + lines.length * lineHeight);
  const w = note.w ?? 520;
  return `<g class="note">
    <rect ${attrs({ x: note.x, y: note.y, width: w, height: h, rx: 8, fill: note.fill ?? "#f8fafc", stroke: note.stroke ?? "#cbd5e1", "stroke-width": 2 })}/>
    <text ${attrs({ x: note.x + 18, y: note.y + 34, "font-size": note.fontSize ?? 20, "font-weight": 500, fill: note.color ?? "#334155" })}>
      ${lines.map((line, index) => `<tspan x="${esc(note.x + 18)}" dy="${index === 0 ? 0 : lineHeight}">${esc(line)}</tspan>`).join("")}
    </text>
  </g>`;
}

function renderLegend(items = []) {
  if (!items.length) return "";
  const x = spec.legend?.x ?? 80;
  const y = spec.legend?.y ?? height - 88;
  let cursor = x;
  return `<g class="legend">
    ${items.map((item) => {
      const palette = tone(item.tone);
      const label = item.label ?? item.tone;
      const boxW = Math.max(112, label.length * 13 + 54);
      const out = `<g>
        <rect ${attrs({ x: cursor, y, width: 28, height: 18, rx: 4, fill: palette.fill, stroke: palette.stroke, "stroke-width": 2 })}/>
        <text ${attrs({ x: cursor + 40, y: y + 16, "font-size": 18, "font-weight": 600, fill: "#334155" })}>${esc(label)}</text>
      </g>`;
      cursor += boxW;
      return out;
    }).join("")}
  </g>`;
}

const arrows = spec.arrows ?? [];

const body = [
  ...(spec.zones ?? []).map(renderZone),
  ...arrows.filter((arrow) => !arrow.drawAboveNodes).map(renderArrowPath),
  ...(spec.nodes ?? []).map(renderNode),
  ...arrows.filter((arrow) => arrow.drawAboveNodes).map(renderArrowPath),
  ...arrows.map(renderArrowOverlay),
  ...(spec.notes ?? []).map(renderNote),
  renderLegend(spec.legend?.items ?? []),
].join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
  <defs>
    ${renderMarkerDefs(arrows)}
    <style>
      svg { background: ${bg}; }
      text { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    </style>
  </defs>
  <rect width="100%" height="100%" fill="${esc(bg)}"/>
  ${title && spec.showTitle ? multilineText(title, 80, 64, { anchor: "start", size: 32, weight: 750, color: "#111827" }) : ""}
  ${body}
</svg>
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, svg);
console.log(`Wrote ${outputPath}`);
