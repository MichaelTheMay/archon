import { webSearch, xSearch } from "@ai-sdk/xai";
import type { LocalContext, Node, Op } from "@archon/core";
import { RESEARCHER_SYSTEM } from "./prompts.js";
import type { Provider } from "./provider.js";
import { ResearchOutput } from "./schemas.js";

/**
 * Deep research, dispatched by the Orchestrator when an Expander flags a decision as
 * depending on facts that move. Uses xAI's provider-executed search tools, so the model
 * runs the searches itself over multiple steps before answering.
 */
export async function runResearcher(
  provider: Provider,
  query: string,
  ctx: LocalContext,
): Promise<{ output: ResearchOutput; usage: { inputTokens: number; outputTokens: number }; model: string }> {
  const prompt = [
    `Research question: ${query}`,
    ``,
    `It is being asked to resolve this design decision: ${ctx.decision.label}`,
    `Options on the table: ${(ctx.decision.data.kind === "decision" ? ctx.decision.data.options : []).join(" | ") || "(open)"}`,
    ``,
    `The design must satisfy these requirements:`,
    ...ctx.requirements.map((r) => `- ${r.label}${r.data.kind === "requirement" && r.data.target ? ` (target: ${r.data.target})` : ""}`),
    ``,
    `Search for what is true right now, then answer.`,
  ].join("\n");

  const res = await provider.structured({
    role: "researcher",
    system: RESEARCHER_SYSTEM,
    prompt,
    schema: ResearchOutput,
    cacheKey: `research:${ctx.decision.id}:${query}`,
    tools: { webSearch: webSearch(), xSearch: xSearch() },
    maxSteps: 8,
  });
  return { output: res.object, usage: res.usage, model: res.model };
}

export function compileResearchOps(ctx: LocalContext, query: string, out: ResearchOutput): { ops: Op[]; nodeId: string } {
  const d = ctx.decision;
  const nodeId = `res_${d.id}`;
  const ops: Op[] = [
    {
      op: "addNode",
      node: {
        id: nodeId,
        kind: "research",
        label: query.length > 80 ? `${query.slice(0, 77)}…` : query,
        description: out.recommendation,
        parentId: d.id,
        branchId: d.branchId,
        data: {
          kind: "research",
          query,
          findings: out.findings,
          recommendation: out.recommendation,
          sources: out.sources,
          ...(out.asOf ? { asOf: out.asOf } : {}),
        },
      },
    },
    { op: "addEdge", edge: { id: `e_${nodeId}__informs__${d.id}`, from: nodeId, to: d.id, type: "informs" } },
  ];
  return { ops, nodeId };
}

export function researchFor(nodes: Node[], decisionId: string): Node[] {
  return nodes.filter((n) => n.kind === "research" && n.parentId === decisionId);
}
