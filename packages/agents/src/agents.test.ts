import { describe, expect, it } from "vitest";
import { applyBatch, emptyGraph, type Limits, type Node, type OpBatch } from "@archon/core";
import { compileOps } from "./expander.js";
import { compileForkOps, forkCandidates } from "./critic.js";
import type { ExpanderOutput } from "./schemas.js";

const limits: Limits = { maxNodes: 100, maxDepth: 8, maxChildrenPerDecision: 4 };

const decision = (id: string, branchId: string): Node => ({
  id,
  kind: "decision",
  branchId,
  depth: 1,
  label: "Which datastore?",
  description: "",
  parentId: "root",
  version: 0,
  pinned: false,
  createdAt: 1,
  data: { kind: "decision", question: "Which datastore?", options: ["dynamo", "postgres"], status: "open", attempts: 0 },
});

const ctx = (d: Node) => ({
  decision: d,
  spine: [d],
  siblingDecisions: [],
  requirements: [],
  assumptions: [],
  components: [],
  edges: [],
  branchId: d.branchId,
});

// Both branches propose the same slug — models are deterministic about naming.
const output: ExpanderOutput = {
  needsResearch: false,
  chosen: "dynamo",
  rationale: "fits the access pattern",
  components: [
    { id: "c_store", label: "Mapping store", componentType: "datastore", description: "", responsibilities: [], satisfies: [] },
  ],
  edges: [{ from: "c_store", to: "c_store", type: "flows" }],
  newDecisions: [{ id: "d_partition", question: "How is it partitioned?", options: [] }],
};

describe("branch namespacing", () => {
  it("gives rival branches distinct node ids for the same proposed slug", () => {
    const a = compileOps(ctx(decision("main~d_store", "main")), output);
    const b = compileOps(ctx(decision("alt1~d_store", "alt1")), output);

    const idsOf = (ops: ReturnType<typeof compileOps>) =>
      ops.flatMap((o) => (o.op === "addNode" ? [o.node.id] : o.op === "openDecision" ? [o.id!] : []));

    expect(idsOf(a)).toEqual(["main~c_store", "main~d_partition"]);
    expect(idsOf(b)).toEqual(["alt1~c_store", "alt1~d_partition"]);
    // Without this the reducer's idempotent addNode silently merges the second branch
    // into the first, and forking cannot work at all.
    expect(new Set([...idsOf(a), ...idsOf(b)]).size).toBe(4);
  });

  it("survives the reducer: both branches' nodes coexist", () => {
    let g = emptyGraph();
    const seed: OpBatch = {
      id: "b0", agentId: "t", role: "system", origin: "system", baseVersions: {}, ts: 1,
      ops: [
        { op: "addNode", node: { id: "root", kind: "requirement", label: "root", branchId: "main", depth: 0, data: { kind: "requirement", category: "functional" } } },
        { op: "openDecision", id: "main~d_store", parentId: "root", branchId: "main", question: "Which datastore?" },
        { op: "openDecision", id: "alt1~d_store", parentId: "root", branchId: "alt1", question: "Which datastore?" },
      ],
    };
    const r0 = applyBatch(g, seed, limits);
    if (!r0.ok) throw new Error(r0.rejected.reason);
    g = r0.graph;

    for (const [id, branch] of [["main~d_store", "main"], ["alt1~d_store", "alt1"]] as const) {
      const r = applyBatch(g, {
        ...seed, id: `b_${branch}`, role: "expander", origin: "agent",
        ops: compileOps(ctx({ ...decision(id, branch), parentId: "root" }), output),
      }, limits);
      if (!r.ok) throw new Error(r.rejected.reason);
      g = r.graph;
    }

    expect(g.nodes.has("main~c_store")).toBe(true);
    expect(g.nodes.has("alt1~c_store")).toBe(true);
    expect([...g.nodes.values()].filter((n) => n.kind === "component")).toHaveLength(2);
  });
});

describe("forking", () => {
  it("offers only the alternatives the original did not take", () => {
    const resolved: Node = {
      ...decision("main~d_store", "main"),
      data: { kind: "decision", question: "Which datastore?", options: ["dynamo", "postgres", "cassandra"], status: "resolved", chosen: "dynamo", rationale: "r", attempts: 0 },
    };
    const ops = compileForkOps(resolved, "alt1");
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    if (op.op !== "openDecision") throw new Error("expected openDecision");
    expect(op.branchId).toBe("alt1");
    expect(op.options).toEqual(["postgres", "cassandra"]);
    expect(op.id).toBe("alt1~fork_d_store");
  });

  it("does not offer a fork when there was no real alternative", () => {
    const resolved: Node = {
      ...decision("main~d_x", "main"),
      data: { kind: "decision", question: "q", options: ["only"], status: "resolved", chosen: "only", rationale: "r", attempts: 0 },
    };
    expect(compileForkOps(resolved, "alt1")).toHaveLength(0);
    expect(forkCandidates([resolved], 8)).toHaveLength(0);
  });
});
