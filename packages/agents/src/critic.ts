import { z } from "zod";
import type { BranchSummary, Node, Op } from "@archon/core";
import { CRITIC_SYSTEM } from "./prompts.js";
import type { Provider } from "./provider.js";
import { nsId } from "./expander.js";

export const CriticOutput = z.object({
  holes: z
    .array(
      z.object({
        id: z.string().describe("format d_<slug>"),
        question: z.string().describe("a decision that forces this hole to be addressed"),
        options: z.array(z.string()).default([]),
        severity: z.enum(["low", "medium", "high"]),
        attachTo: z.string().optional().describe("id of the component this concerns, if any"),
      }),
    )
    .default([]),
  decompose: z
    .array(
      z.object({
        componentId: z.string(),
        id: z.string().describe("format d_<slug>"),
        question: z.string().describe("a decision about this component's internals"),
        options: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  unjustified: z.array(z.string()).default([]).describe("component ids no requirement justifies"),
});
export type CriticOutput = z.infer<typeof CriticOutput>;

/**
 * The growth engine. Where the Expander resolves questions, the Critic *creates* them —
 * both by attacking the design (holes) and by pushing into components that are still
 * black boxes (decompose). It never deletes another agent's work.
 */
export async function runCritic(
  provider: Provider,
  summary: BranchSummary,
  version: number,
): Promise<{ output: CriticOutput; usage: { inputTokens: number; outputTokens: number }; model: string }> {
  const prompt = JSON.stringify(
    {
      branchId: summary.branchId,
      requirements: summary.requirements.map((r) => ({
        id: r.id,
        label: r.label,
        target: r.data.kind === "requirement" ? r.data.target : undefined,
        satisfiedBy: summary.satisfied[r.id] ?? [],
      })),
      components: summary.components.map((c) => ({
        id: c.id,
        label: c.label,
        type: c.data.kind === "component" ? c.data.componentType : undefined,
        technology: c.data.kind === "component" ? c.data.technology : undefined,
        description: c.description,
        hasOpenQuestions: false,
      })),
      edges: summary.edges.map((e) => ({ from: e.from, to: e.to, type: e.type, label: e.label })),
      decisionsAlreadyMade: summary.resolvedDecisions.map((d) => ({
        question: d.data.kind === "decision" ? d.data.question : d.label,
        chosen: d.data.kind === "decision" ? d.data.chosen : undefined,
      })),
    },
    null,
    1,
  );

  const res = await provider.structured({
    role: "critic",
    system: CRITIC_SYSTEM,
    prompt,
    schema: CriticOutput,
    cacheKey: `critic:${summary.branchId}:${version}`,
  });
  return { output: res.object, usage: res.usage, model: res.model };
}

export function compileCriticOps(summary: BranchSummary, out: CriticOutput, childBudget: (parentId: string) => number): Op[] {
  const ops: Op[] = [];
  const known = new Set(summary.components.map((c) => c.id));
  const ns = (raw: string) => nsId(summary.branchId, raw);
  const used = new Map<string, number>();

  const takeSlot = (parentId: string): boolean => {
    const spent = used.get(parentId) ?? 0;
    if (spent >= childBudget(parentId)) return false;
    used.set(parentId, spent + 1);
    return true;
  };

  const rootId = summary.components[0]?.id;

  for (const h of out.holes) {
    const attach = h.attachTo && known.has(ns(h.attachTo)) ? ns(h.attachTo) : h.attachTo && known.has(h.attachTo) ? h.attachTo : rootId;
    if (!attach || !takeSlot(attach)) continue;
    ops.push({
      op: "openDecision",
      id: ns(`${h.id}_c`),
      parentId: attach,
      branchId: summary.branchId,
      question: h.question,
      options: h.options,
    });
  }

  for (const d of out.decompose) {
    const parent = known.has(ns(d.componentId)) ? ns(d.componentId) : known.has(d.componentId) ? d.componentId : null;
    if (!parent || !takeSlot(parent)) continue;
    ops.push({
      op: "openDecision",
      id: ns(`${d.id}_x`),
      parentId: parent,
      branchId: summary.branchId,
      question: d.question,
      options: d.options,
    });
  }

  return ops;
}

/**
 * Fork a resolved decision into a rival branch: same question, the alternatives it did not
 * take. Expanding that branch builds a competing subtree, which is what finally gives the
 * Scorer and Pruner more than one candidate to rank.
 */
export function compileForkOps(decision: Node, newBranchId: string): Op[] {
  const d = decision.data;
  if (d.kind !== "decision" || !decision.parentId) return [];
  const alternatives = d.options.filter((o) => o !== d.chosen);
  if (!alternatives.length) return [];
  return [
    {
      op: "openDecision",
      id: `${newBranchId}~fork_${decision.id.replace(/^[^~]*~/, "")}`,
      parentId: decision.parentId,
      branchId: newBranchId,
      question: d.question,
      options: alternatives,
    },
  ];
}

/** Resolved decisions worth forking: real alternatives, shallow enough to matter. */
export function forkCandidates(nodes: Node[], maxDepth: number): Node[] {
  return nodes
    .filter((n) => {
      const d = n.data;
      if (d.kind !== "decision" || d.status !== "resolved" || !n.parentId || n.depth > maxDepth) return false;
      return d.options.some((o) => o !== d.chosen);
    })
    .sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt);
}
