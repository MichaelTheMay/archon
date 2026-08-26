import type { BranchSummary } from "@archon/core";
import { SCORER_SYSTEM } from "./prompts.js";
import type { Provider } from "./provider.js";
import { ScorerOutput } from "./schemas.js";

export async function runScorer(
  provider: Provider,
  summary: BranchSummary,
  version: number,
): Promise<{ output: ScorerOutput; usage: { inputTokens: number; outputTokens: number }; model: string }> {
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
      })),
      edges: summary.edges.map((e) => ({ from: e.from, to: e.to, type: e.type, label: e.label })),
      decisions: summary.resolvedDecisions.map((d) => ({
        question: d.data.kind === "decision" ? d.data.question : d.label,
        chosen: d.data.kind === "decision" ? d.data.chosen : undefined,
        rationale: d.data.kind === "decision" ? d.data.rationale : undefined,
      })),
      openDecisionCount: summary.openDecisionCount,
    },
    null,
    1,
  );

  const res = await provider.structured({
    role: "scorer",
    system: SCORER_SYSTEM,
    prompt,
    schema: ScorerOutput,
    cacheKey: `scorer:${summary.branchId}:${version}`,
  });
  return { output: res.object, usage: res.usage, model: res.model };
}
