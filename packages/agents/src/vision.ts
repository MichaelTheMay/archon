import type { LayoutSnapshot, Op, SerializedGraph } from "@archon/core";
import type { Provider } from "./provider.js";

/**
 * v1. A sparse QA gate, not a reasoning input: the graph is authoritative for semantics,
 * the screenshot only catches rendering pathologies deterministic layout still produces
 * (edge crossings, label overflow, unreadable density). Runs at checkpoints, not every tick.
 */
export interface VisionValidator {
  validate(provider: Provider, png: Uint8Array, graph: SerializedGraph, layout: LayoutSnapshot): Promise<Op[]>;
}

/** Cheap heuristics that answer most of "does it look right" with no model call. */
export function layoutMetrics(graph: SerializedGraph, layout: LayoutSnapshot) {
  const boxes = Object.entries(layout.nodes);
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]![1];
      const b = boxes[j]![1];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) overlaps++;
    }
  }
  const fanout = new Map<string, number>();
  for (const e of graph.edges) fanout.set(e.from, (fanout.get(e.from) ?? 0) + 1);
  const maxFanout = Math.max(0, ...fanout.values());
  const longLabels = graph.nodes.filter((n) => n.label.length > 48).map((n) => n.id);
  return { overlaps, maxFanout, longLabels, nodeCount: graph.nodes.length };
}

export const notImplementedVision: VisionValidator = {
  async validate() {
    throw new Error("VisionValidator not implemented (v1)");
  },
};
