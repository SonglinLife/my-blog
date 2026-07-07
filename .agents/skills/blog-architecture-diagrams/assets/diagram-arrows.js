/*
 * Diagram arrow runtime.
 *
 * Injected inline into .built.html by build-html-diagram.js. It replaces
 * hand-written SVG arrow coordinates with element-anchored declarations:
 *
 *   <div class="dg-arrow" data-from="node-a" data-to="node-b"
 *        data-label="read volumes" data-step="1"></div>
 *
 * Supported attributes:
 *   data-from / data-to   required, ids of anchor elements
 *   data-route            h | v | auto (default auto)
 *   data-exit / data-enter left|right|top|bottom edge overrides
 *   data-exit-at / data-enter-at  0..1 fraction along the chosen edge (default 0.5)
 *   data-mid              0..1 fraction for the middle segment position (default 0.5)
 *   data-lane             px offset added to the middle segment position
 *   data-tone             accent (solid blue, default) | muted (dashed gray)
 *   data-label            label chip text (step number is merged into the chip)
 *   data-step             step number rendered inside the label chip
 *   data-label-at         0..1 fraction along the path for the chip (default 0.5)
 *
 * After drawing, it audits geometry (generated AND hand-written arrows) and
 * publishes a JSON report in a data-dg-report JSON tag appended to the body.
 */
(function () {
  "use strict";

  const GAP_START = 6;
  const GAP_END = 9;
  const CORNER = 14;
  const SAMPLE_STEP = 5;
  const ENDPOINT_SKIP = 14;

  const TONES = {
    accent: { stroke: "#2563eb", width: 2.5, dash: null },
    muted: { stroke: "#94a3b8", width: 2.5, dash: "7 5" },
  };

  function run() {
    const root = document.querySelector("main[data-diagram-root]");
    const report = [];
    if (!root) {
      publish([{ level: "error", message: "missing <main data-diagram-root>" }]);
      return;
    }

    // Idempotent re-run: drop anything we generated before.
    for (const el of root.querySelectorAll("[data-dg-generated]")) el.remove();

    const rootRect = root.getBoundingClientRect();
    const width = Number(root.dataset.width || Math.round(rootRect.width));
    const height = Number(root.dataset.height || Math.round(rootRect.height));
    const toLocal = (r) => ({
      x: r.left - rootRect.left,
      y: r.top - rootRect.top,
      w: r.width,
      h: r.height,
    });

    const specs = Array.from(root.querySelectorAll(".dg-arrow"));
    const arrows = [];

    for (const spec of specs) {
      const fromId = spec.dataset.from;
      const toId = spec.dataset.to;
      const from = fromId ? document.getElementById(fromId) : null;
      const to = toId ? document.getElementById(toId) : null;
      if (!from || !to) {
        report.push({
          level: "error",
          message: `dg-arrow references missing element: from="${fromId}" to="${toId}"`,
        });
        continue;
      }
      const a = toLocal(from.getBoundingClientRect());
      const b = toLocal(to.getBoundingClientRect());
      const route = routeArrow(a, b, spec.dataset);
      arrows.push({ spec, from: fromId, to: toId, points: route.points, dataset: spec.dataset });
    }

    // Build (or reuse) the SVG overlay for generated arrows.
    let svg = null;
    if (arrows.length) {
      svg = createSvg(width, height);
      for (const arrow of arrows) {
        const tone = TONES[arrow.dataset.tone] || TONES.accent;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", roundedPath(arrow.points, CORNER));
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", tone.stroke);
        path.setAttribute("stroke-width", String(tone.width));
        if (tone.dash) path.setAttribute("stroke-dasharray", tone.dash);
        path.setAttribute(
          "marker-end",
          arrow.dataset.tone === "muted" ? "url(#dg-head-muted)" : "url(#dg-head)"
        );
        path.dataset.dgArrow = `${arrow.from}->${arrow.to}`;
        svg.appendChild(path);
        arrow.pathEl = path;
      }
      root.appendChild(svg);
    }

    // Obstacles for geometry checks and label placement.
    const nodeRects = Array.from(root.querySelectorAll(".dg-node, .dg-note, .dg-legend")).map(
      (el) => ({ el, rect: toLocal(el.getBoundingClientRect()) })
    );
    const titleRects = collectTitleRects(root, toLocal);

    // Place label chips (step number merged into the chip).
    const chips = [];
    for (const arrow of arrows) {
      const text = (arrow.dataset.label || "").trim();
      const step = (arrow.dataset.step || "").trim();
      if (!text && !step) continue;
      const chip = placeChip(root, arrow, text, step, toLocal, nodeRects, titleRects, chips, report);
      if (chip) chips.push(chip);
    }

    audit(root, toLocal, nodeRects, titleRects, chips, report, width, height);
    publish(report);
  }

  function routeArrow(a, b, ds) {
    const exitSide = ds.exit || autoSide(a, b, ds.route, true);
    const enterSide = ds.enter || autoSide(b, a, ds.route, false);
    const p0 = edgePoint(a, exitSide, num(ds.exitAt, 0.5), GAP_START);
    const p1 = edgePoint(b, enterSide, num(ds.enterAt, 0.5), GAP_END);
    const mid = num(ds.mid, 0.5);
    const lane = num(ds.lane, 0);
    const points = [p0];

    const horizontalExit = exitSide === "left" || exitSide === "right";
    const horizontalEnter = enterSide === "left" || enterSide === "right";

    if (horizontalExit && horizontalEnter) {
      if (Math.abs(p0.y - p1.y) < 3) {
        // straight horizontal
      } else {
        const x = p0.x + (p1.x - p0.x) * mid + lane;
        points.push({ x, y: p0.y }, { x, y: p1.y });
      }
    } else if (!horizontalExit && !horizontalEnter) {
      if (Math.abs(p0.x - p1.x) < 3) {
        // straight vertical
      } else {
        const y = p0.y + (p1.y - p0.y) * mid + lane;
        points.push({ x: p0.x, y }, { x: p1.x, y });
      }
    } else if (horizontalExit) {
      points.push({ x: p1.x + lane, y: p0.y });
    } else {
      points.push({ x: p0.x + lane, y: p1.y });
    }

    points.push(p1);
    return { points };
  }

  function autoSide(self, other, route, isExit) {
    const cxSelf = self.x + self.w / 2;
    const cySelf = self.y + self.h / 2;
    const cxOther = other.x + other.w / 2;
    const cyOther = other.y + other.h / 2;
    const dx = cxOther - cxSelf;
    const dy = cyOther - cySelf;
    if (route === "h") return dx >= 0 ? (isExit ? "right" : "right") : "left";
    if (route === "v") return dy >= 0 ? (isExit ? "bottom" : "bottom") : "top";
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
    return dy >= 0 ? "bottom" : "top";
  }

  function edgePoint(r, side, at, gap) {
    if (side === "left") return { x: r.x - gap, y: r.y + r.h * at };
    if (side === "right") return { x: r.x + r.w + gap, y: r.y + r.h * at };
    if (side === "top") return { x: r.x + r.w * at, y: r.y - gap };
    return { x: r.x + r.w * at, y: r.y + r.h + gap };
  }

  function roundedPath(points, radius) {
    if (points.length < 2) return "";
    let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const next = points[i + 1];
      const r = Math.min(radius, dist(prev, cur) / 2, dist(cur, next) / 2);
      if (r < 2) {
        d += ` L ${fmt(cur.x)} ${fmt(cur.y)}`;
        continue;
      }
      const inPt = towards(cur, prev, r);
      const outPt = towards(cur, next, r);
      d += ` L ${fmt(inPt.x)} ${fmt(inPt.y)} Q ${fmt(cur.x)} ${fmt(cur.y)} ${fmt(outPt.x)} ${fmt(outPt.y)}`;
    }
    const last = points[points.length - 1];
    d += ` L ${fmt(last.x)} ${fmt(last.y)}`;
    return d;
  }

  function createSvg(width, height) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "dg-arrows");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("aria-hidden", "true");
    svg.dataset.dgGenerated = "arrows";
    const defs = document.createElementNS(NS, "defs");
    defs.innerHTML =
      '<marker id="dg-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" orient="auto"><path d="M 1.5 1.5 L 8.5 5 L 1.5 8.5 Z" fill="#2563eb"/></marker>' +
      '<marker id="dg-head-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" orient="auto"><path d="M 1.5 1.5 L 8.5 5 L 1.5 8.5 Z" fill="#94a3b8"/></marker>';
    svg.appendChild(defs);
    return svg;
  }

  function placeChip(root, arrow, text, step, toLocal, nodeRects, titleRects, chips, report) {
    const chip = document.createElement("span");
    chip.className = "dg-label";
    chip.dataset.dgGenerated = "label";
    if (step) {
      const s = document.createElement("span");
      s.className = "dg-label-step";
      s.textContent = step;
      chip.appendChild(s);
    }
    if (text) chip.appendChild(document.createTextNode(text));
    root.appendChild(chip);

    const size = chip.getBoundingClientRect();
    const givenAt = num(arrow.dataset.labelAt, 0.5);
    // Slide along the path and away from it until the chip clears all text.
    const ats = [givenAt, ...[0.3, 0.7, 0.15, 0.85, 0.5].filter((v) => v !== givenAt)];
    const candidates = [];
    for (const at of ats) {
      const anchor = pointAlongPolyline(arrow.points, at);
      const normal = segmentNormal(arrow.points, at);
      for (const gap of [16, 30, 46, 66, 90]) {
        for (const dir of [1, -1]) {
          candidates.push({
            x: anchor.x + dir * normal.x * gap - size.width / 2,
            y: anchor.y + dir * normal.y * gap - size.height / 2,
          });
        }
      }
    }

    const obstacles = nodeRects
      .map((n) => n.rect)
      .concat(titleRects.map((t) => t.rect))
      .concat(chips.map((c) => c.rect));
    let chosen = null;
    for (const cand of candidates) {
      const rect = { x: cand.x, y: cand.y, w: size.width, h: size.height };
      if (obstacles.some((o) => intersects(rect, o, 2))) continue;
      chosen = rect;
      break;
    }
    if (!chosen) {
      chosen = { x: candidates[0].x, y: candidates[0].y, w: size.width, h: size.height };
      report.push({
        level: "error",
        message: `label "${step ? step + " " : ""}${text}" (${arrow.from}->${arrow.to}) overlaps other content everywhere along its path; shorten the label, or change data-label-at / data-mid / layout`,
      });
    }
    chip.style.left = `${fmt(chosen.x)}px`;
    chip.style.top = `${fmt(chosen.y)}px`;
    return { rect: chosen, text: `${step ? step + " " : ""}${text}`, arrow };
  }

  function collectTitleRects(root, toLocal) {
    // Zone/pool titles are ::before pseudo-elements from data-title; approximate
    // their box from computed padding-origin and the title text length.
    const rects = [];
    for (const el of root.querySelectorAll(".dg-zone[data-title], .dg-pool[data-title]")) {
      const r = toLocal(el.getBoundingClientRect());
      const title = el.dataset.title || "";
      const lines = title.split(/\n/);
      const longest = Math.max(...lines.map((l) => l.length));
      const fontPx = el.classList.contains("dg-pool") ? 20 : 25;
      rects.push({
        el,
        rect: {
          x: r.x + 22,
          y: r.y + 18,
          w: Math.min(r.w - 40, longest * fontPx * 0.62),
          h: lines.length * fontPx * 1.3,
        },
      });
    }
    return rects;
  }

  function audit(root, toLocal, nodeRects, titleRects, chips, report, width, height) {
    // Audit every arrow path on the canvas: generated and hand-written.
    const paths = Array.from(root.querySelectorAll("svg.dg-arrows path")).filter(
      (p) => !p.closest("defs") && !p.closest("marker")
    );
    const sampled = paths.map((p) => ({ el: p, points: samplePath(p) }));

    for (const { el, points } of sampled) {
      if (!points.length) continue;
      const name = el.dataset.dgArrow || (el.getAttribute("d") || "").slice(0, 40);
      const hits = new Set();
      for (const pt of points) {
        for (const { el: node, rect } of nodeRects) {
          if (contains(rect, pt, -2)) hits.add(describe(node));
        }
        for (const { el: zone, rect } of titleRects) {
          if (contains(rect, pt, 0)) hits.add(`title of ${describe(zone)}`);
        }
        for (const chip of chips) {
          if (chip.arrow && chip.arrow.pathEl === el) continue;
          if (contains(chip.rect, pt, 0)) hits.add(`label "${chip.text}"`);
        }
        if (pt.x < 0 || pt.y < 0 || pt.x > width || pt.y > height) hits.add("canvas edge (out of bounds)");
      }
      for (const hit of hits) {
        report.push({ level: "error", message: `arrow ${name} crosses ${hit}` });
      }
    }

    // Arrow/arrow crossings (warn only).
    for (let i = 0; i < sampled.length; i++) {
      for (let j = i + 1; j < sampled.length; j++) {
        if (polylinesCross(sampled[i].points, sampled[j].points)) {
          report.push({
            level: "warn",
            message: `arrows ${label(sampled[i].el)} and ${label(sampled[j].el)} cross each other; consider data-mid/data-lane or different lanes`,
          });
        }
      }
    }

    // Legacy absolutely-positioned step circles.
    const legacySteps = Array.from(root.querySelectorAll(".dg-step")).filter(
      (s) => !s.closest("[data-dg-generated]")
    );
    for (const stepEl of legacySteps) {
      const r = toLocal(stepEl.getBoundingClientRect());
      const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      for (const { el: node, rect } of nodeRects) {
        if (intersects(r, rect, -4)) {
          report.push({
            level: "error",
            message: `step circle "${stepEl.textContent.trim()}" overlaps ${describe(node)}`,
          });
        }
      }
      if (sampled.length) {
        let best = Infinity;
        for (const { points } of sampled) {
          for (const pt of points) best = Math.min(best, dist(center, pt));
        }
        if (best > 26) {
          report.push({
            level: "warn",
            message: `step circle "${stepEl.textContent.trim()}" is ${Math.round(best)}px from the nearest arrow path`,
          });
        }
      }
    }

    // Placed chips must not sit on nodes or zone titles.
    for (const chip of chips) {
      for (const { el: node, rect } of nodeRects) {
        if (intersects(chip.rect, rect, 0)) {
          report.push({ level: "error", message: `label "${chip.text}" overlaps ${describe(node)}` });
        }
      }
      for (const { el: zone, rect } of titleRects) {
        if (intersects(chip.rect, rect, 0)) {
          report.push({
            level: "error",
            message: `label "${chip.text}" overlaps the title of ${describe(zone)}`,
          });
        }
      }
    }

    // Step-count discipline.
    const stepCount =
      legacySteps.length + Array.from(root.querySelectorAll(".dg-arrow[data-step]")).length;
    if (stepCount > 7) {
      report.push({
        level: "warn",
        message: `${stepCount} numbered steps; readers rarely follow more than 7 - split phases or split the diagram`,
      });
    }

    function label(el) {
      return el.dataset.dgArrow || "(hand-written)";
    }
  }

  function samplePath(pathEl) {
    let total = 0;
    try {
      total = pathEl.getTotalLength();
    } catch {
      return [];
    }
    if (!isFinite(total) || total <= ENDPOINT_SKIP * 2) return [];
    const points = [];
    for (let d = ENDPOINT_SKIP; d <= total - ENDPOINT_SKIP; d += SAMPLE_STEP) {
      const pt = pathEl.getPointAtLength(d);
      points.push({ x: pt.x, y: pt.y });
    }
    return points;
  }

  function pointAlongPolyline(points, t) {
    const lengths = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const l = dist(points[i - 1], points[i]);
      lengths.push(l);
      total += l;
    }
    let target = total * clamp(t, 0, 1);
    for (let i = 1; i < points.length; i++) {
      const l = lengths[i - 1];
      if (target <= l || i === points.length - 1) {
        const f = l ? target / l : 0;
        return {
          x: points[i - 1].x + (points[i].x - points[i - 1].x) * f,
          y: points[i - 1].y + (points[i].y - points[i - 1].y) * f,
        };
      }
      target -= l;
    }
    return points[0];
  }

  function segmentNormal(points, t) {
    const lengths = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const l = dist(points[i - 1], points[i]);
      lengths.push(l);
      total += l;
    }
    let target = total * clamp(t, 0, 1);
    for (let i = 1; i < points.length; i++) {
      const l = lengths[i - 1];
      if (target <= l || i === points.length - 1) {
        const dx = points[i].x - points[i - 1].x;
        const dy = points[i].y - points[i - 1].y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: -dy / len, y: dx / len };
      }
      target -= l;
    }
    return { x: 0, y: -1 };
  }

  function polylinesCross(a, b) {
    for (const pa of a) {
      for (const pb of b) {
        if (Math.abs(pa.x - pb.x) < 3 && Math.abs(pa.y - pb.y) < 3) return true;
      }
    }
    return false;
  }

  function describe(el) {
    if (el.id) return `#${el.id}`;
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32);
    return `"${text}"`;
  }

  function contains(rect, pt, inset) {
    return (
      pt.x >= rect.x - inset &&
      pt.x <= rect.x + rect.w + inset &&
      pt.y >= rect.y - inset &&
      pt.y <= rect.y + rect.h + inset
    );
  }

  function intersects(a, b, inset) {
    return !(
      a.x + a.w < b.x - inset ||
      b.x + b.w < a.x - inset ||
      a.y + a.h < b.y - inset ||
      b.y + b.h < a.y - inset
    );
  }

  function towards(from, to, d) {
    const len = dist(from, to) || 1;
    return { x: from.x + ((to.x - from.x) / len) * d, y: from.y + ((to.y - from.y) / len) * d };
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function fmt(n) {
    return String(Math.round(n * 10) / 10);
  }

  function publish(report) {
    const prev = document.querySelector("script[data-dg-report]");
    if (prev) prev.remove();
    const tag = document.createElement("script");
    tag.type = "application/json";
    tag.dataset.dgReport = "1";
    tag.textContent = JSON.stringify(report);
    document.body.appendChild(tag);
    document.documentElement.dataset.dgDone = "1";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
