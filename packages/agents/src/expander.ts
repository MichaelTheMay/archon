import type { LocalContext, Node, Op } from "@archon/core";
import type { Provider } from "./provider.js";
import { EXPANDER_SYSTEM } from "./prompts.js";
import { ExpanderOutput } from "./schemas.js";

function brief(n: Node): Record<string, unknown> {
  const base = { id: n.id, kind: n.kind, label: n.label };
  if (n.data.kind === "decision")
    return { ...base, status: n.data.status, chosen: n.data.chosen, rationale: n.data.rationale };
  if (n.data.kind === "component")
    return { ...base, type: n.data.componentType, technology: n.data.technology, description: n.description };
  if (n.data.kind === "requirement") return { ...base, category: n.data.category, target: n.data.target };
  if (n.data.kind === "research")
    return { ...base, query: n.data.query, recommendation: n.data.recommendation, findings: n.data.findings };
  return base;
}

export function renderContext(ctx: LocalContext, research: Node[]): string {
  return JSON.stringify(
    {
      decisionToResolve: brief(ctx.decision),
      ancestors: ctx.spine.slice(0, -1).map(brief),
      resolvedSiblings: ctx.siblingDecisions.map(brief),
      requirements: ctx.requirements.map(brief),
      assumptions: ctx.assumptions.map(brief),
      existingComponents: ctx.components.map(brief),
      existingEdges: ctx.edges.map((e) => ({ from: e.from, to: e.to, type: e.type, label: e.label })),
      research: research.map(brief),
    },
    null,
    1,
  );
}

export async function runExpander(
  provider: Provider,
  ctx: LocalContext,
  research: Node[],
  agentId: string,
): Promise<{ output: ExpanderOutput; usage: { inputTokens: number; outputTokens: number }; model: string }> {
  const prompt = renderContext(ctx, research);
  const res = await provider.structured({
    role: "expander",
    system: EXPANDER_SYSTEM,
    prompt,
    schema: ExpanderOutput,
    cacheKey: `expander:${ctx.decision.id}:${ctx.decision.version}:${research.length}`,
  });
  void agentId;
  return { output: res.object, usage: res.usage, model: res.model };
}

/** Deterministic edge ids: replay must reproduce the same ids, or the scrubber churns. */
export const edgeId = (from: string, type: string, to: string) => `e_${from}__${type}__${to}`;

/**
 * Compile an Expander's proposal into validated core Ops.
 * The server owns id namespacing and edge typing; the model never touches layout.
 *
 * `childBudget` is the number of new decisions this parent can still accept. Batches are
 * atomic, so an over-eager model returning one decision too many would otherwise get the
 * whole batch — including its resolution — rejected. We truncate here instead.
 */
export function compileOps(ctx: LocalContext, out: ExpanderOutput, childBudget = Infinity): Op[] {
  const d = ctx.decision;
  const ops: Op[] = [];
  const known = new Set([
    ...ctx.components.map((c) => c.id),
    ...ctx.requirements.map((r) => r.id),
    ...ctx.spine.map((n) => n.id),
  ]);

  ops.push({ op: "resolveDecision", id: d.id, chosen: out.chosen, rationale: out.rationale });

  for (const c of out.components) {
    if (known.has(c.id)) continue;
    known.add(c.id);
    ops.push({
      op: "addNode",
      node: {
        id: c.id,
        kind: "component",
        label: c.label,
        description: c.description,
        parentId: d.id,
        branchId: d.branchId,
        data: {
          kind: "component",
          componentType: c.componentType,
          responsibilities: c.responsibilities,
          ...(c.technology ? { technology: c.technology } : {}),
        },
      },
    });
    ops.push({ op: "addEdge", edge: { id: edgeId(c.id, "resolves", d.id), from: c.id, to: d.id, type: "resolves" } });
    for (const reqId of c.satisfies) {
      if (ctx.requirements.some((r) => r.id === reqId)) {
        ops.push({ op: "addEdge", edge: { id: edgeId(c.id, "satisfies", reqId), from: c.id, to: reqId, type: "satisfies" } });
      }
    }
  }

  for (const e of out.edges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    ops.push({
      op: "addEdge",
      edge: {
        id: edgeId(e.from, e.type, e.to),
        from: e.from,
        to: e.to,
        type: e.type,
        ...(e.label ? { label: e.label } : {}),
        ...(e.sync !== undefined ? { sync: e.sync } : {}),
        ...(e.protocol ? { protocol: e.protocol } : {}),
      },
    });
  }

  for (const nd of out.newDecisions.slice(0, Math.max(0, childBudget))) {
    ops.push({
      op: "openDecision",
      id: nd.id,
      parentId: d.id,
      branchId: d.branchId,
      question: nd.question,
      options: nd.options,
    });
  }

  return ops;
}
