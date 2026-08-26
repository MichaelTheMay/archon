import ELK from "elkjs/lib/elk.bundled.js";
import { nodeSize, separate, type LayoutSnapshot, type SerializedGraph } from "@archon/core";

const elk = new ELK();

const BRANCH_GAP = 420;
const BRANCH_PAD = 60;

/**
 * Deterministic layout. Agents never emit coordinates; this is the only thing that does.
 * Each branch is laid out independently and tiled horizontally, so one branch churning
 * does not reshuffle its neighbours.
 */
export async function layoutGraph(graph: SerializedGraph): Promise<LayoutSnapshot> {
  const branches = [...new Set(graph.nodes.map((n) => n.branchId))].sort();
  const out: LayoutSnapshot = { nodes: {}, branches: {} };
  let cursorX = 0;

  for (const branchId of branches) {
    const nodes = graph.nodes.filter((n) => n.branchId === branchId);
    if (!nodes.length) continue;
    const ids = new Set(nodes.map((n) => n.id));
    // Only structural edges drive layout. `satisfies` and `informs` are annotations that
    // fan from every component back to shared requirements — feeding them to ELK collapses
    // the tree into one flat hairball. They are still drawn, just not laid out against.
    const STRUCTURAL = new Set(["child_of", "flows", "depends_on"]);
    const edges = graph.edges.filter(
      (e) => STRUCTURAL.has(e.type) && ids.has(e.from) && ids.has(e.to) && e.from !== e.to,
    );

    const elkGraph = {
      id: `branch_${branchId}`,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.layered.spacing.nodeNodeBetweenLayers": "120",
        "elk.spacing.nodeNode": "60",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.layered.crossingMinimization.semiInteractive": "true",
        // The decision tree fans out hard and stays shallow; without this the canvas is
        // a single unreadable 20,000px-wide row.
        "elk.aspectRatio": "1.6",
        "elk.layered.wrapping.strategy": "MULTI_EDGE",
      },
      children: nodes.map((n) => {
        // Size from the actual label so ELK reserves enough room; otherwise long text
        // overflows its box and collides with neighbours that never geometrically overlap.
        const s = nodeSize(n);
        return {
          id: n.id,
          width: s.w,
          height: s.h,
          ...(n.pinnedPosition
            ? { x: n.pinnedPosition.x, y: n.pinnedPosition.y, layoutOptions: { "elk.position": `(${n.pinnedPosition.x},${n.pinnedPosition.y})` } }
            : {}),
        };
      }),
      edges: edges.map((e, i) => ({ id: e.id || `e${i}`, sources: [e.from], targets: [e.to] })),
    };

    type Laid = { id: string; x?: number; y?: number; width?: number; height?: number };
    const res = (await elk.layout(elkGraph as never)) as { children?: Laid[] };
    let maxX = 0;
    let maxY = 0;
    const pinned = new Map(nodes.filter((n) => n.pinnedPosition).map((n) => [n.id, n.pinnedPosition!]));
    for (const c of res.children ?? []) {
      // ELK treats elk.position as a hint under `layered`, so a dragged node would snap
      // back. A human's placement is authoritative: overwrite it here.
      const pin = pinned.get(c.id);
      const x = pin ? pin.x : cursorX + (c.x ?? 0);
      const y = pin ? pin.y : (c.y ?? 0);
      const w = c.width ?? 200;
      const h = c.height ?? 80;
      out.nodes[c.id] = { x, y, w, h };
      maxX = Math.max(maxX, (pin ? pin.x - cursorX : (c.x ?? 0)) + w);
      maxY = Math.max(maxY, y + h);
    }
    out.branches[branchId] = {
      x: cursorX - BRANCH_PAD,
      y: -BRANCH_PAD,
      w: maxX + BRANCH_PAD * 2,
      h: maxY + BRANCH_PAD * 2,
    };
    cursorX += maxX + BRANCH_GAP;
  }

  // Last-resort guard: ELK never overlaps boxes, but a human-pinned position can land on
  // top of one. Push the unpinned neighbours aside rather than letting the canvas go ugly.
  const pinnedIds = new Set(graph.nodes.filter((n) => n.pinnedPosition).map((n) => n.id));
  if (pinnedIds.size) separate(out.nodes, pinnedIds);

  return out;
}

/** Trailing-edge debounce so a burst of committed batches produces one layout pass. */
export function debounceLayout(fn: (g: SerializedGraph) => void, ms = 300) {
  let t: NodeJS.Timeout | undefined;
  let pending: SerializedGraph | undefined;
  return (g: SerializedGraph) => {
    pending = g;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      if (pending) fn(pending);
    }, ms);
  };
}
