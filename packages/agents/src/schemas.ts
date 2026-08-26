import { z } from "zod";
import { SCORE_DIMS } from "@archon/core";

/**
 * Agent-facing schemas. Deliberately looser than the core Op union: models are bad at
 * discriminated unions with 7 arms, so Expanders describe intent and the server compiles
 * it into validated Ops. This keeps the "LLMs never emit coordinates" invariant free.
 */

export const ProposedComponent = z.object({
  id: z.string().describe("stable id, format c_<slug>"),
  label: z.string(),
  componentType: z.enum(["service", "datastore", "queue", "cache", "gateway", "client", "external"]),
  technology: z.string().optional().describe("concrete tech if the decision picked one"),
  description: z.string(),
  responsibilities: z.array(z.string()).default([]),
  satisfies: z.array(z.string()).default([]).describe("requirement node ids this exists to satisfy"),
});

export const ProposedEdge = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(["flows", "depends_on"]).default("flows"),
  label: z.string().optional(),
  sync: z.boolean().optional(),
  protocol: z.string().optional(),
});

export const ProposedDecision = z.object({
  id: z.string().describe("stable id, format d_<slug>"),
  question: z.string(),
  options: z.array(z.string()).default([]),
});

export const ExpanderOutput = z.object({
  needsResearch: z.boolean().default(false),
  researchQuery: z.string().optional().describe("required when needsResearch is true"),
  chosen: z.string().describe("the resolution of this decision"),
  rationale: z.string().describe("why, tied to a specific requirement"),
  components: z.array(ProposedComponent).default([]),
  edges: z.array(ProposedEdge).default([]),
  newDecisions: z.array(ProposedDecision).default([]),
});
export type ExpanderOutput = z.infer<typeof ExpanderOutput>;

export const ResearchOutput = z.object({
  findings: z.array(z.string()).min(1),
  recommendation: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  sources: z.array(z.object({ title: z.string(), url: z.string().optional() })).default([]),
  asOf: z.string().optional(),
});
export type ResearchOutput = z.infer<typeof ResearchOutput>;

export const ScorerOutput = z.object({
  vector: z.object(
    Object.fromEntries(SCORE_DIMS.map((d) => [d, z.number().min(0).max(10)])) as Record<
      (typeof SCORE_DIMS)[number],
      z.ZodNumber
    >,
  ),
  justification: z.object(
    Object.fromEntries(SCORE_DIMS.map((d) => [d, z.string()])) as Record<
      (typeof SCORE_DIMS)[number],
      z.ZodString
    >,
  ),
  weakRationale: z.array(z.string()).default([]),
});
export type ScorerOutput = z.infer<typeof ScorerOutput>;

export const IntakeOutput = z.object({
  title: z.string(),
  requirements: z.array(
    z.object({
      id: z.string().describe("format r_<slug>"),
      label: z.string(),
      category: z.enum(["functional", "scale", "latency", "availability", "consistency", "cost", "security", "other"]),
      target: z.string().optional(),
    }),
  ).min(1),
  assumptions: z.array(
    z.object({
      id: z.string().describe("format a_<slug>"),
      label: z.string(),
      confidence: z.enum(["low", "medium", "high"]).default("medium"),
    }),
  ).default([]),
  rootDecisions: z.array(ProposedDecision).min(1).max(5),
});
export type IntakeOutput = z.infer<typeof IntakeOutput>;
