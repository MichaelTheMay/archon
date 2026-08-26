import { cloneGraph, type DesignGraph } from "./graph.js";
import { Op, type Limits, type Node, type OpBatch } from "./schema.js";

export type Rejection = {
  reason: string;
  opIndex?: number;
};

export type ApplyResult =
  | { ok: true; graph: DesignGraph; touched: string[] }
  | { ok: false; rejected: Rejection };

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/**
 * Apply a batch atomically. Returns a new graph or a rejection; the input graph is never mutated.
 * Optimistic concurrency: agent batches must match `baseVersions` for every node they touch.
 * Human-origin batches always win.
 */
export function applyBatch(input: DesignGraph, batch: OpBatch, limits: Limits): ApplyResult {
  const g = cloneGraph(input);
  const touched = new Set<string>();
  const now = batch.ts;

  if (batch.origin !== "human") {
    for (const [id, v] of Object.entries(batch.baseVersions)) {
      const n = g.nodes.get(id);
      if (n && n.version !== v) {
        return { ok: false, rejected: { reason: `version conflict on ${id}: expected ${v}, have ${n.version}` } };
      }
    }
  }

  const bump = (n: Node) => {
    n.version += 1;
    touched.add(n.id);
  };

  for (let i = 0; i < batch.ops.length; i++) {
    const parsed = Op.safeParse(batch.ops[i]);
    if (!parsed.success) return { ok: false, rejected: { reason: `invalid op: ${parsed.error.message}`, opIndex: i } };
    const op = parsed.data;

    switch (op.op) {
      case "addNode": {
        const n = op.node;
        // Idempotent: parallel expanders working from local context routinely propose the
        // same component id. That is agreement, not a conflict — and rejecting the batch
        // would throw away the expander's resolution along with it.
        if (g.nodes.has(n.id)) break;
        const parent = n.parentId ? g.nodes.get(n.parentId) : undefined;
        if (n.parentId && !parent) return { ok: false, rejected: { reason: `missing parent: ${n.parentId}`, opIndex: i } };
        const depth = n.depth ?? (parent ? parent.depth + 1 : 0);
        const branchId = n.branchId ?? parent?.branchId ?? "main";
        if (depth > limits.maxDepth) return { ok: false, rejected: { reason: `depth ${depth} > maxDepth`, opIndex: i } };
        if (g.nodes.size >= limits.maxNodes) return { ok: false, rejected: { reason: `node limit ${limits.maxNodes} reached`, opIndex: i } };
        const node: Node = {
          ...n,
          depth,
          branchId,
          description: n.description ?? "",
          pinned: n.pinned ?? false,
          version: 0,
          createdAt: now,
        };
        g.nodes.set(node.id, node);
        touched.add(node.id);
        if (parent) g.edges.set(newId("e"), { id: "", from: node.id, to: parent.id, type: "child_of" });
        break;
      }
      case "updateNode": {
        const n = g.nodes.get(op.id);
        if (!n) return { ok: false, rejected: { reason: `missing node: ${op.id}`, opIndex: i } };
        const { data, pinnedPosition, ...rest } = op.patch;
        Object.assign(n, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
        if (pinnedPosition === null) delete n.pinnedPosition;
        else if (pinnedPosition) n.pinnedPosition = pinnedPosition;
        if (data) n.data = { ...n.data, ...data } as Node["data"];
        bump(n);
        break;
      }
      case "removeNode": {
        const n = g.nodes.get(op.id);
        if (!n) return { ok: false, rejected: { reason: `missing node: ${op.id}`, opIndex: i } };
        if (n.pinned && batch.origin !== "human") return { ok: false, rejected: { reason: `node pinned: ${op.id}`, opIndex: i } };
        // cascade: remove subtree + incident edges
        const stack = [op.id];
        while (stack.length) {
          const id = stack.pop()!;
          g.nodes.delete(id);
          touched.add(id);
          for (const [eid, e] of g.edges) if (e.from === id || e.to === id) g.edges.delete(eid);
          for (const c of g.nodes.values()) if (c.parentId === id) stack.push(c.id);
        }
        break;
      }
      case "addEdge": {
        const e = op.edge;
        if (!g.nodes.has(e.from) || !g.nodes.has(e.to))
          return { ok: false, rejected: { reason: `edge references missing node: ${e.from}->${e.to}`, opIndex: i } };
        const id = e.id ?? newId("e");
        g.edges.set(id, { ...e, id });
        touched.add(e.from);
        touched.add(e.to);
        break;
      }
      case "removeEdge": {
        if (!g.edges.delete(op.id)) return { ok: false, rejected: { reason: `missing edge: ${op.id}`, opIndex: i } };
        break;
      }
      case "openDecision": {
        const parent = op.parentId ? g.nodes.get(op.parentId) : undefined;
        if (op.parentId && !parent) return { ok: false, rejected: { reason: `missing parent: ${op.parentId}`, opIndex: i } };
        const depth = parent ? parent.depth + 1 : 0;
        if (depth > limits.maxDepth) return { ok: false, rejected: { reason: `depth ${depth} > maxDepth`, opIndex: i } };
        if (g.nodes.size >= limits.maxNodes) return { ok: false, rejected: { reason: `node limit reached`, opIndex: i } };
        // The fan-out cap exists to stop agents from running away. A human asking a
        // follow-up is not runaway — and deep parents legitimately sit at the cap, so
        // enforcing it here would silently reject exactly the questions worth asking.
        if (parent && batch.origin !== "human") {
          const siblings = [...g.nodes.values()].filter((n) => n.parentId === parent.id && n.kind === "decision").length;
          if (siblings >= limits.maxChildrenPerDecision)
            return { ok: false, rejected: { reason: `fan-out cap ${limits.maxChildrenPerDecision} on ${parent.id}`, opIndex: i } };
        }
        const id = op.id ?? newId("d");
        if (g.nodes.has(id)) break; // same decision reached from two branches: idempotent
        const node: Node = {
          id,
          kind: "decision",
          branchId: op.branchId ?? parent?.branchId ?? "main",
          depth,
          label: op.question,
          description: "",
          version: 0,
          pinned: false,
          createdAt: now,
          data: { kind: "decision", question: op.question, options: op.options ?? [], status: "open", attempts: 0 },
          ...(parent ? { parentId: parent.id } : {}),
        };
        g.nodes.set(id, node);
        touched.add(id);
        if (parent) g.edges.set(newId("e"), { id: "", from: id, to: parent.id, type: "child_of" });
        break;
      }
      case "resolveDecision": {
        const n = g.nodes.get(op.id);
        if (!n || n.data.kind !== "decision") return { ok: false, rejected: { reason: `not a decision: ${op.id}`, opIndex: i } };
        n.data = { ...n.data, status: "resolved", chosen: op.chosen, rationale: op.rationale };
        bump(n);
        break;
      }
    }
  }

  // fix up edge ids assigned as "" (child_of created inline)
  for (const [eid, e] of g.edges) if (e.id === "") g.edges.set(eid, { ...e, id: eid });

  return { ok: true, graph: g, touched: [...touched] };
}
