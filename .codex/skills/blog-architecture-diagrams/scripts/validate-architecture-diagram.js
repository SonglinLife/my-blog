#!/usr/bin/env node
import fs from "node:fs";

const files = process.argv.slice(2);

if (!files.length) {
  console.error("Usage: node validate-architecture-diagram.js <diagram.json> [...]");
  process.exit(1);
}

const DEFAULTS = {
  nodePadding: 6,
  minSegmentLength: 28,
  maxArrowWidth: 4,
  maxPathRatio: 2.2,
  maxBends: 3,
};

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

function expand(rect, padding) {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    w: rect.w + padding * 2,
    h: rect.h + padding * 2,
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function pointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

function segmentsIntersect(a, b, c, d) {
  function orient(p, q, r) {
    return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  }

  function onSegment(p, q, r) {
    return (
      q.x <= Math.max(p.x, r.x) &&
      q.x >= Math.min(p.x, r.x) &&
      q.y <= Math.max(p.y, r.y) &&
      q.y >= Math.min(p.y, r.y)
    );
  }

  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);

  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;
  return false;
}

function segmentIntersectsRect(start, end, rect) {
  if (pointInRect(start, rect) || pointInRect(end, rect)) return true;
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ];
  return corners.some((corner, index) => segmentsIntersect(start, end, corner, corners[(index + 1) % corners.length]));
}

function textLines(text) {
  return String(text ?? "").split(/\n/);
}

function nodeBox(idOrPoint, nodes) {
  if (typeof idOrPoint === "string") {
    const item = nodes.get(idOrPoint);
    if (!item) throw new Error(`Unknown node id in arrow: ${idOrPoint}`);
    return item;
  }
  return { x: idOrPoint.x, y: idOrPoint.y, w: 1, h: 1 };
}

function arrowGeometry(arrow, nodes) {
  const fromBox = nodeBox(arrow.from, nodes);
  const toBox = nodeBox(arrow.to, nodes);
  const fromCenter = center(fromBox);
  const toCenter = center(toBox);
  let start = typeof arrow.from === "string" ? edgePoint(fromBox, arrow.points?.[0] ?? toCenter) : { x: arrow.from.x, y: arrow.from.y };
  let end = typeof arrow.to === "string" ? edgePoint(toBox, arrow.points?.at(-1) ?? fromCenter) : { x: arrow.to.x, y: arrow.to.y };
  const middle = arrow.points ?? [];
  const rawPoints = [start, ...middle, end];

  if (typeof arrow.from === "string" && rawPoints[1]) {
    start = moveToward(start, rawPoints[1], arrow.startGap ?? 8);
  }
  if (typeof arrow.to === "string" && rawPoints.at(-2)) {
    end = moveToward(end, rawPoints.at(-2), arrow.endGap ?? 16);
  }

  const points = [start, ...middle, end];
  const mid = points[Math.floor((points.length - 1) / 2)];
  const next = points[Math.min(points.length - 1, Math.floor((points.length - 1) / 2) + 1)];
  const labelX = arrow.labelX ?? (mid.x + next.x) / 2;
  const labelY = arrow.labelY ?? (mid.y + next.y) / 2 - 16;
  const firstNext = points[1];
  const stepPoint = arrow.stepAt
    ? { x: arrow.stepAt.x, y: arrow.stepAt.y }
    : firstNext
      ? pointAlong(points[0], firstNext, arrow.stepDistance ?? 38, arrow.stepOffset ?? 0)
      : points[0];

  return { points, labelX, labelY, stepPoint };
}

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

function labelBox(arrow, geometry) {
  if (!arrow.label) return null;
  const lines = textLines(arrow.label);
  const w = arrow.labelWidth ?? 150;
  const h = arrow.labelHeight ?? Math.max(34, lines.length * (arrow.labelLineHeight ?? 24) + 14);
  return {
    x: geometry.labelX - w / 2,
    y: geometry.labelY - h / 2,
    w,
    h,
  };
}

function stepBox(arrow, geometry) {
  if (!arrow.step) return null;
  const r = arrow.stepRadius ?? 19;
  return {
    x: geometry.stepPoint.x + (arrow.stepX ?? 0) - r,
    y: geometry.stepPoint.y + (arrow.stepY ?? 0) - r,
    w: r * 2,
    h: r * 2,
  };
}

function textMetricBox(text, x, y, options = {}) {
  const lines = textLines(text);
  const size = options.size ?? 25;
  const lineHeight = options.lineHeight ?? Math.round(size * 1.25);
  const width = Math.max(...lines.map((line) => line.length), 1) * size * 0.62;
  const height = lines.length * lineHeight;
  return {
    x,
    y: y - lineHeight * 0.75,
    w: width,
    h: height,
  };
}

function zoneLabelBoxes(spec) {
  return (spec.zones ?? [])
    .filter((zone) => zone.label)
    .map((zone) => ({
      id: zone.id,
      ...textMetricBox(zone.label, zone.x + 24, zone.y + 38, {
        size: zone.labelSize ?? 25,
      }),
    }));
}

function validateFile(file) {
  const spec = JSON.parse(fs.readFileSync(file, "utf8"));
  const nodes = new Map((spec.nodes ?? []).map((node) => [node.id, node]));
  const zoneLabels = zoneLabelBoxes(spec);
  const issues = [];

  function issue(level, message) {
    issues.push({ level, message });
  }

  for (const [index, arrow] of (spec.arrows ?? []).entries()) {
    const name = arrow.id ?? arrow.label ?? `${arrow.from}->${arrow.to}`;
    let geometry;
    try {
      geometry = arrowGeometry(arrow, nodes);
    } catch (error) {
      issue("error", `arrow ${index + 1} (${name}): ${error.message}`);
      continue;
    }

    if ((arrow.width ?? 3) > DEFAULTS.maxArrowWidth) {
      issue("error", `arrow ${index + 1} (${name}): width ${arrow.width} is too heavy; keep arrows at ${DEFAULTS.maxArrowWidth}px or less`);
    }

    if ((arrow.points ?? []).length > DEFAULTS.maxBends) {
      issue("warn", `arrow ${index + 1} (${name}): has ${(arrow.points ?? []).length} bend points; prefer ${DEFAULTS.maxBends} or fewer`);
    }

    const direct = Math.hypot(geometry.points.at(-1).x - geometry.points[0].x, geometry.points.at(-1).y - geometry.points[0].y);
    const ratio = direct > 0 ? pathLength(geometry.points) / direct : 1;
    if (ratio > DEFAULTS.maxPathRatio) {
      issue("warn", `arrow ${index + 1} (${name}): path length is ${ratio.toFixed(1)}x the direct distance; reserve a cleaner lane`);
    }

    for (let segmentIndex = 1; segmentIndex < geometry.points.length; segmentIndex += 1) {
      const start = geometry.points[segmentIndex - 1];
      const end = geometry.points[segmentIndex];
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length < DEFAULTS.minSegmentLength) {
        issue("error", `arrow ${index + 1} (${name}): segment ${segmentIndex} is only ${length.toFixed(0)}px; avoid tiny arrowhead stubs`);
      }

      for (const node of nodes.values()) {
        if (node.id === arrow.from || node.id === arrow.to) continue;
        const padded = expand(node, DEFAULTS.nodePadding);
        if (segmentIntersectsRect(start, end, padded)) {
          issue("error", `arrow ${index + 1} (${name}): segment ${segmentIndex} crosses node "${node.id}"`);
        }
      }

      for (const label of zoneLabels) {
        if (segmentIntersectsRect(start, end, expand(label, DEFAULTS.nodePadding))) {
          issue("error", `arrow ${index + 1} (${name}): segment ${segmentIndex} crosses zone label "${label.id}"`);
        }
      }
    }

    const lbox = labelBox(arrow, geometry);
    if (lbox) {
      for (const node of nodes.values()) {
        if (rectsOverlap(lbox, expand(node, DEFAULTS.nodePadding))) {
          issue("error", `arrow ${index + 1} (${name}): label overlaps node "${node.id}"`);
        }
      }
      for (const label of zoneLabels) {
        if (rectsOverlap(lbox, expand(label, DEFAULTS.nodePadding))) {
          issue("error", `arrow ${index + 1} (${name}): label overlaps zone label "${label.id}"`);
        }
      }
    }

    const sbox = stepBox(arrow, geometry);
    if (sbox) {
      for (const node of nodes.values()) {
        if (rectsOverlap(sbox, expand(node, DEFAULTS.nodePadding))) {
          issue("error", `arrow ${index + 1} (${name}): step circle overlaps node "${node.id}"`);
        }
      }
      for (const label of zoneLabels) {
        if (rectsOverlap(sbox, expand(label, DEFAULTS.nodePadding))) {
          issue("error", `arrow ${index + 1} (${name}): step circle overlaps zone label "${label.id}"`);
        }
      }
      if (lbox && rectsOverlap(sbox, lbox)) {
        issue("error", `arrow ${index + 1} (${name}): step circle overlaps its label`);
      }
    }
  }

  const geometries = (spec.arrows ?? []).map((arrow) => {
    try {
      return arrowGeometry(arrow, nodes);
    } catch {
      return null;
    }
  });

  for (let i = 0; i < geometries.length; i += 1) {
    for (let j = i + 1; j < geometries.length; j += 1) {
      const a = geometries[i];
      const b = geometries[j];
      if (!a || !b) continue;

      for (let ai = 1; ai < a.points.length; ai += 1) {
        for (let bi = 1; bi < b.points.length; bi += 1) {
          if (segmentsIntersect(a.points[ai - 1], a.points[ai], b.points[bi - 1], b.points[bi])) {
            issue("error", `arrow ${i + 1} crosses arrow ${j + 1}; reserve separate arrow lanes`);
          }
        }
      }
    }
  }

  if (issues.length) {
    console.error(`\n${file}`);
    for (const item of issues) {
      console.error(`  [${item.level}] ${item.message}`);
    }
  } else {
    console.log(`${file}: diagram geometry passed`);
  }

  return issues.some((item) => item.level === "error");
}

let failed = false;
for (const file of files) {
  failed = validateFile(file) || failed;
}

process.exit(failed ? 1 : 0);
