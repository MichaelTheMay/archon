import type { Edge, Node } from "./schema.js";

export interface DesignGraph {
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
}

export function emptyGraph(): DesignGraph {
  return { nodes: new Map(), edges: new Map() };
}

export function cloneGraph(g: DesignGraph): DesignGraph {
  return {
    nodes: new Map([...g.nodes].map(([k, v]) => [k, structuredClone(v)])),
    edges: new Map([...g.edges].map(([k, v]) => [k, structuredClone(v)])),
  };
}

export interface SerializedGraph {
  nodes: Node[];
  edges: Edge[];
}

export function serializeGraph(g: DesignGraph): SerializedGraph {
  return { nodes: [...g.nodes.values()], edges: [...g.edges.values()] };
}

export function deserializeGraph(s: SerializedGraph): DesignGraph {
  return {
    nodes: new Map(s.nodes.map((n) => [n.id, n])),
    edges: new Map(s.edges.map((e) => [e.id, e])),
  };
}

export function edgesOf(g: DesignGraph, nodeId: string): Edge[] {
  return [...g.edges.values()].filter((e) => e.from === nodeId || e.to === nodeId);
}

export function childrenOf(g: DesignGraph, nodeId: string): Node[] {
  return [...g.nodes.values()].filter((n) => n.parentId === nodeId);
}

/** Root → ... → node. */
export function spine(g: DesignGraph, nodeId: string): Node[] {
  const out: Node[] = [];
  let cur = g.nodes.get(nodeId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? g.nodes.get(cur.parentId) : undefined;
  }
  return out;
}

export function branchNodes(g: DesignGraph, branchId: string): Node[] {
  return [...g.nodes.values()].filter((n) => n.branchId === branchId);
}

export function branchIds(g: DesignGraph): string[] {
  return [...new Set([...g.nodes.values()].map((n) => n.branchId))];
}

/** Component subgraph within `hops` of the given node ids (BFS over flows/depends_on). */
export function neighborhood(g: DesignGraph, seeds: string[], hops: number): Set<string> {
  const seen = new Set(seeds);
  let frontier = seeds;
  for (let i = 0; i < hops && frontier.length; i++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of edgesOf(g, id)) {
        if (e.type !== "flows" && e.type !== "depends_on") continue;
        const other = e.from === id ? e.to : e.from;
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/**
 * The compact context an Expander sees for one decision:
 * ancestor spine, siblings' resolved decisions, requirements/assumptions,
 * and the 2-hop component neighbourhood of the branch.
 */
export interface LocalContext {
  decision: Node;
  spine: Node[];
  siblingDecisions: Node[];
  requirements: Node[];
  assumptions: Node[];
  components: Node[];
  edges: Edge[];
  branchId: string;
}

export function localContext(g: DesignGraph, decisionId: string, hops = 2): LocalContext {
  const decision = g.nodes.get(decisionId);
  if (!decision || decision.kind !== "decision") throw new Error(`not a decision: ${decisionId}`);
  const sp = spine(g, decisionId);
  const siblingDecisions = decision.parentId
    ? childrenOf(g, decision.parentId).filter(
        (n) => n.kind === "decision" && n.id !== decisionId && n.data.kind === "decision" && n.data.status === "resolved",
      )
    : [];
  const all = [...g.nodes.values()];
  const requirements = all.filter((n) => n.kind === "requirement");
  const assumptions = all.filter((n) => n.kind === "assumption");
  const branchComponents = all.filter((n) => n.kind === "component" && n.branchId === decision.branchId);
  const spineComponentIds = sp.filter((n) => n.kind === "component").map((n) => n.id);
  const seeds = spineComponentIds.length ? spineComponentIds : branchComponents.map((n) => n.id);
  const near = neighborhood(g, seeds, hops);
  const components = branchComponents.filter((n) => near.has(n.id));
  const compIds = new Set(components.map((n) => n.id));
  const edges = [...g.edges.values()].filter((e) => compIds.has(e.from) && compIds.has(e.to));
  return { decision, spine: sp, siblingDecisions, requirements, assumptions, components, edges, branchId: decision.branchId };
}

export interface BranchSummary {
  branchId: string;
  components: Node[];
  edges: Edge[];
  resolvedDecisions: Node[];
  openDecisionCount: number;
  requirements: Node[];
  satisfied: Record<string, string[]>; // requirementId -> componentIds
}

export function branchSummary(g: DesignGraph, branchId: string): BranchSummary {
  const nodes = branchNodes(g, branchId);
  const components = nodes.filter((n) => n.kind === "component");
  const compIds = new Set(components.map((n) => n.id));
  const decisions = nodes.filter((n) => n.kind === "decision");
  const resolvedDecisions = decisions.filter((n) => n.data.kind === "decision" && n.data.status === "resolved");
  const openDecisionCount = decisions.filter((n) => n.data.kind === "decision" && n.data.status === "open").length;
  const requirements = [...g.nodes.values()].filter((n) => n.kind === "requirement");
  const satisfied: Record<string, string[]> = {};
  for (const r of requirements) satisfied[r.id] = [];
  for (const e of g.edges.values()) {
    if (e.type === "satisfies" && compIds.has(e.from)) satisfied[e.to]?.push(e.from);
  }
  const edges = [...g.edges.values()].filter((e) => compIds.has(e.from) && compIds.has(e.to));
  return { branchId, components, edges, resolvedDecisions, openDecisionCount, requirements, satisfied };
}
