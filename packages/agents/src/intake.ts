import type { Op } from "@archon/core";
import { INTAKE_SYSTEM } from "./prompts.js";
import type { Provider } from "./provider.js";
import { IntakeOutput } from "./schemas.js";

export async function runIntake(
  provider: Provider,
  idea: string,
  notes?: string,
): Promise<{ output: IntakeOutput; usage: { inputTokens: number; outputTokens: number }; model: string }> {
  const res = await provider.structured({
    role: "orchestrator",
    system: INTAKE_SYSTEM,
    prompt: `Idea: ${idea}${notes ? `\n\nContext / constraints from the user:\n${notes}` : ""}`,
    schema: IntakeOutput,
    cacheKey: `intake:${idea}:${notes ?? ""}`,
  });
  return { output: res.object, usage: res.usage, model: res.model };
}

export interface IntakeLimits {
  /** Must match the reducer's fan-out cap, or the atomic intake batch is rejected whole. */
  maxRootDecisions?: number;
  /** Total nodes intake may create. Framing must not eat the whole node budget. */
  maxNodes?: number;
}

/**
 * Batches are atomic, so anything the reducer would refuse takes the entire intake with
 * it — leaving an empty canvas. Truncate here instead: requirements and assumptions are
 * trimmed first, root decisions last, since decisions are what drive the loop.
 */
export function compileIntakeOps(out: IntakeOutput, branchId = "main", limits: IntakeLimits = {}): Op[] {
  const maxRootDecisions = limits.maxRootDecisions ?? Infinity;
  const decisions = out.rootDecisions.slice(0, Math.max(1, maxRootDecisions));
  // budget: root node + decisions are non-negotiable; requirements/assumptions flex.
  const flex = Math.max(2, (limits.maxNodes ?? Infinity) - 1 - decisions.length);
  const reqCount = Math.min(out.requirements.length, Math.max(1, Math.ceil(flex * 0.7)));
  const requirements = out.requirements.slice(0, reqCount);
  const assumptions = out.assumptions.slice(0, Math.max(0, flex - reqCount));

  const ops: Op[] = [
    {
      op: "addNode",
      node: {
        id: "root",
        kind: "requirement",
        label: out.title,
        description: "Design run root",
        branchId,
        depth: 0,
        pinned: true,
        data: { kind: "requirement", category: "functional" },
      },
    },
  ];

  for (const r of requirements) {
    ops.push({
      op: "addNode",
      node: {
        id: r.id,
        kind: "requirement",
        label: r.label,
        description: r.target ?? "",
        parentId: "root",
        branchId,
        pinned: true,
        data: { kind: "requirement", category: r.category, ...(r.target ? { target: r.target } : {}) },
      },
    });
  }

  for (const a of assumptions) {
    ops.push({
      op: "addNode",
      node: {
        id: a.id,
        kind: "assumption",
        label: a.label,
        parentId: "root",
        branchId,
        data: { kind: "assumption", confidence: a.confidence },
      },
    });
  }

  for (const d of decisions) {
    ops.push({
      op: "openDecision",
      id: d.id,
      parentId: "root",
      branchId,
      question: d.question,
      options: d.options,
    });
  }

  return ops;
}
