import type { Node } from "./schema.js";

/**
 * Node label and size, shared by the layout engine and the canvas projection.
 *
 * These MUST agree. ELK reserves space using these numbers and tldraw renders text into
 * them; if the two disagree, long labels spill out of their boxes and visually collide
 * with neighbours even though the boxes themselves never overlap.
 */

/** Roughly tldraw's "s" sans font at scale 1. */
const CHAR_W = 6.6;
const LINE_H = 19;
const PAD_X = 14;
const PAD_Y = 16;

/**
 * A diamond's inscribed text area is about half its bounding box, and an ellipse's about
 * 0.64 of it. Sizing every kind as if it were a rectangle is exactly why decision nodes
 * spilled their text over their own edges. These scale the box, not the text.
 */
const SHAPE_SLACK: Record<string, number> = {
  decision: 1.45, // diamond
  assumption: 1.2, // ellipse
  research: 1.15, // cloud
  component: 1,
  requirement: 1,
};

const BASE: Record<string, { minW: number; maxW: number; minH: number }> = {
  component: { minW: 200, maxW: 300, minH: 84 },
  // minW is pre-slack; a short question should not inherit a long one's footprint.
  decision: { minW: 180, maxW: 300, minH: 72 },
  requirement: { minW: 200, maxW: 300, minH: 76 },
  assumption: { minW: 200, maxW: 300, minH: 76 },
  research: { minW: 220, maxW: 320, minH: 88 },
};

/** Long labels are truncated on canvas; the Inspector shows the full text. */
export const MAX_LABEL = 150;

export function displayLabel(n: Node): string {
  const head = n.label.length > MAX_LABEL ? `${n.label.slice(0, MAX_LABEL - 1).trimEnd()}…` : n.label;
  if (n.data.kind === "component" && n.data.technology) return `${head}\n${n.data.technology}`;
  if (n.data.kind === "requirement" && n.data.target) return `${head}\n${n.data.target}`;
  return head;
}

export function nodeSize(n: Node): { w: number; h: number } {
  const base = BASE[n.kind] ?? BASE.component!;
  const text = displayLabel(n);

  // Widen with length so a long question does not become a 12-line sliver, but cap it
  // so one verbose node cannot dominate the canvas.
  const grown = Math.ceil(Math.sqrt(text.length * CHAR_W * LINE_H * 2.2));
  const w = Math.min(base.maxW, Math.max(base.minW, grown));

  const slack = SHAPE_SLACK[n.kind] ?? 1;
  // Text wraps to the *inscribed* width, which for a diamond or ellipse is narrower than
  // the box, so compute lines against that before scaling the box back up.
  const inner = w / slack;
  const perLine = Math.max(8, Math.floor((inner - PAD_X * 2) / CHAR_W));
  const lines = text
    .split("\n")
    .reduce((acc, line) => acc + Math.max(1, Math.ceil(line.length / perLine)), 0);
  const h = Math.max(base.minH, (lines * LINE_H + PAD_Y * 2) * slack);

  return { w: Math.round(w * slack), h: Math.round(h) };
}

/**
 * Deterministic last-resort separation. ELK does not overlap boxes, but a human dragging a
 * node to a pinned position can land it on top of another. Rather than fight the user or
 * let the canvas go ugly, push the *unpinned* neighbours out of the way.
 */
export function separate(
  boxes: Record<string, { x: number; y: number; w: number; h: number }>,
  pinned: Set<string>,
  gap = 16,
  passes = 12,
): number {
  const ids = Object.keys(boxes);
  let moved = 0;
  for (let pass = 0; pass < passes; pass++) {
    let collisions = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = boxes[ids[i]!]!;
        const b = boxes[ids[j]!]!;
        const dx = Math.min(a.x + a.w + gap - b.x, b.x + b.w + gap - a.x);
        const dy = Math.min(a.y + a.h + gap - b.y, b.y + b.h + gap - a.y);
        if (dx <= 0 || dy <= 0) continue;
        collisions++;
        // Resolve along the cheaper axis, and only move whichever box is free to move.
        const aFree = !pinned.has(ids[i]!);
        const bFree = !pinned.has(ids[j]!);
        if (!aFree && !bFree) continue;
        const share = aFree && bFree ? 0.5 : 1;
        if (dx < dy) {
          const dir = a.x <= b.x ? 1 : -1;
          if (aFree) a.x -= dx * share * dir;
          if (bFree) b.x += dx * share * dir;
        } else {
          const dir = a.y <= b.y ? 1 : -1;
          if (aFree) a.y -= dy * share * dir;
          if (bFree) b.y += dy * share * dir;
        }
        moved++;
      }
    }
    if (!collisions) break;
  }
  return moved;
}
