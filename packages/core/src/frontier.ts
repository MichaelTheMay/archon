import type { DesignGraph } from "./graph.js";
import type { Node } from "./schema.js";

/** Open decisions in BFS order: shallowest first, then oldest first. Stalled decisions excluded. */
export function openDecisions(g: DesignGraph): Node[] {
  return [...g.nodes.values()]
    .filter((n) => n.kind === "decision" && n.data.kind === "decision" && n.data.status === "open")
    .sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function stalledDecisions(g: DesignGraph): Node[] {
  return [...g.nodes.values()].filter((n) => n.data.kind === "decision" && n.data.status === "stalled");
}
