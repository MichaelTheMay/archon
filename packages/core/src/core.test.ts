import { describe, expect, it } from "vitest";
import { applyBatch } from "./reducer.js";
import { emptyGraph } from "./graph.js";
import { openDecisions } from "./frontier.js";
import { isPlateau, pruneCandidates } from "./score.js";
import type { BranchScore, Limits, OpBatch } from "./schema.js";

const limits: Limits = { maxNodes: 10, maxDepth: 3, maxChildrenPerDecision: 2 };
const batch = (ops: OpBatch["ops"], extra: Partial<OpBatch> = {}): OpBatch => ({
  id: "b1",
  agentId: "t",
  role: "expander",
  origin: "agent",
  baseVersions: {},
  ops,
  ts: 1,
  ...extra,
});

describe("reducer", () => {
  it("adds nodes, decisions and child_of edges", () => {
    const r = applyBatch(emptyGraph(), batch([
      { op: "openDecision", id: "d0", question: "root?" },
      { op: "addNode", node: { id: "c1", kind: "component", label: "API", parentId: "d0", data: { kind: "component", componentType: "service", responsibilities: [] } } },
    ]), limits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.get("c1")?.depth).toBe(1);
    expect([...r.graph.edges.values()].filter((e) => e.type === "child_of")).toHaveLength(1);
  });

  it("treats re-adding an existing node as a no-op, not a rejection", () => {
    // Two parallel expanders proposing the same component is agreement; rejecting the
    // batch would discard the rest of the expander's work with it.
    const r0 = applyBatch(emptyGraph(), batch([{ op: "openDecision", id: "d0", question: "q" }]), limits);
    if (!r0.ok) throw new Error();
    const r1 = applyBatch(r0.graph, batch([
      { op: "openDecision", id: "d0", question: "q" },
      { op: "openDecision", id: "d9", question: "new" },
    ]), limits);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.graph.nodes.size).toBe(2);
  });

  it("rejects atomically on a bad op", () => {
    const g = emptyGraph();
    const r = applyBatch(g, batch([
      { op: "openDecision", id: "d0", question: "root?" },
      { op: "addEdge", edge: { from: "d0", to: "nope", type: "flows" } },
    ]), limits);
    expect(r.ok).toBe(false);
    expect(g.nodes.size).toBe(0);
  });

  it("enforces version conflicts for agents but not humans", () => {
    const r0 = applyBatch(emptyGraph(), batch([{ op: "openDecision", id: "d0", question: "q" }]), limits);
    if (!r0.ok) throw new Error();
    const r1 = applyBatch(r0.graph, batch([{ op: "resolveDecision", id: "d0", chosen: "a", rationale: "b" }]), limits);
    if (!r1.ok) throw new Error();
    const stale = batch([{ op: "updateNode", id: "d0", patch: { label: "x" } }], { baseVersions: { d0: 0 } });
    expect(applyBatch(r1.graph, stale, limits).ok).toBe(false);
    expect(applyBatch(r1.graph, { ...stale, origin: "human" }, limits).ok).toBe(true);
  });

  it("enforces depth, node and fan-out limits", () => {
    let g = emptyGraph();
    const step = (ops: OpBatch["ops"]) => {
      const r = applyBatch(g, batch(ops), limits);
      if (r.ok) g = r.graph;
      return r.ok;
    };
    expect(step([{ op: "openDecision", id: "d0", question: "q" }])).toBe(true);
    expect(step([{ op: "openDecision", id: "d1", parentId: "d0", question: "q" }])).toBe(true);
    expect(step([{ op: "openDecision", id: "d2", parentId: "d0", question: "q" }])).toBe(true);
    expect(step([{ op: "openDecision", id: "d3", parentId: "d0", question: "q" }])).toBe(false); // fan-out
    // ...but a human asking a follow-up is never runaway expansion.
    const human = { ...batch([{ op: "openDecision" as const, id: "d3h", parentId: "d0", question: "q" }]), origin: "human" as const };
    expect(applyBatch(g, human, limits).ok).toBe(true);
    expect(step([{ op: "openDecision", id: "d4", parentId: "d1", question: "q" }])).toBe(true);
    expect(step([{ op: "openDecision", id: "d5", parentId: "d4", question: "q" }])).toBe(true);
    expect(step([{ op: "openDecision", id: "d6", parentId: "d5", question: "q" }])).toBe(false); // depth
  });

  it("cascades removal and protects pinned nodes", () => {
    const r0 = applyBatch(emptyGraph(), batch([
      { op: "openDecision", id: "d0", question: "q" },
      { op: "openDecision", id: "d1", parentId: "d0", question: "q" },
      { op: "updateNode", id: "d1", patch: { pinned: true } },
    ]), limits);
    if (!r0.ok) throw new Error();
    expect(applyBatch(r0.graph, batch([{ op: "removeNode", id: "d1" }]), limits).ok).toBe(false);
    const r1 = applyBatch(r0.graph, batch([{ op: "removeNode", id: "d0" }]), limits);
    expect(r1.ok && r1.graph.nodes.size === 0 && r1.graph.edges.size === 0).toBe(true);
  });
});

describe("frontier", () => {
  it("orders BFS: depth then age", () => {
    const r = applyBatch(emptyGraph(), batch([
      { op: "openDecision", id: "a", question: "q" },
      { op: "openDecision", id: "b", parentId: "a", question: "q" },
      { op: "openDecision", id: "c", question: "q" },
      { op: "resolveDecision", id: "a", chosen: "x", rationale: "y" },
    ]), limits);
    if (!r.ok) throw new Error();
    expect(openDecisions(r.graph).map((n) => n.id)).toEqual(["c", "b"]);
  });
});

describe("score", () => {
  const s = (branchId: string, scalar: number): BranchScore => ({ branchId, scalar, vector: {} as never, justification: {}, weakRationale: [], ts: 0 });
  it("prunes outliers below median − 1.5σ, never pinned", () => {
    const scores = [s("a", 8), s("b", 8.2), s("c", 7.9), s("d", 8.1), s("e", 2)];
    expect(pruneCandidates(scores, new Set())).toEqual(["e"]);
    expect(pruneCandidates(scores, new Set(["e"]))).toEqual([]);
    expect(pruneCandidates(scores.slice(0, 2), new Set())).toEqual([]);
  });
  it("detects plateau", () => {
    expect(isPlateau([5, 6, 7, 7.05, 7.1])).toBe(false);
    expect(isPlateau([6, 7, 7.02, 7.05, 7.1])).toBe(true);
    expect(isPlateau([5, 6, 7, 7.5, 8])).toBe(false);
    expect(isPlateau([7, 7])).toBe(false);
  });
});
