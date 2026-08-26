import { z } from "zod";

// ── Nodes ─────────────────────────────────────────────────────────────

export const NodeKind = z.enum(["component", "decision", "requirement", "assumption", "research"]);
export type NodeKind = z.infer<typeof NodeKind>;

export const ComponentType = z.enum([
  "service",
  "datastore",
  "queue",
  "cache",
  "gateway",
  "client",
  "external",
]);
export type ComponentType = z.infer<typeof ComponentType>;

export const ComponentData = z.object({
  kind: z.literal("component"),
  componentType: ComponentType,
  technology: z.string().optional(),
  responsibilities: z.array(z.string()).default([]),
});

export const DecisionStatus = z.enum(["open", "resolved", "stalled"]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

export const DecisionData = z.object({
  kind: z.literal("decision"),
  question: z.string(),
  options: z.array(z.string()).default([]),
  status: DecisionStatus.default("open"),
  chosen: z.string().optional(),
  rationale: z.string().optional(),
  attempts: z.number().int().default(0),
});

export const RequirementData = z.object({
  kind: z.literal("requirement"),
  category: z.enum(["functional", "scale", "latency", "availability", "consistency", "cost", "security", "other"]),
  target: z.string().optional(),
});

export const AssumptionData = z.object({
  kind: z.literal("assumption"),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
});

/** Output of a deep-research agent, attached to the decision that requested it. */
export const ResearchData = z.object({
  kind: z.literal("research"),
  query: z.string(),
  findings: z.array(z.string()).default([]),
  recommendation: z.string().optional(),
  sources: z.array(z.object({ title: z.string(), url: z.string().optional() })).default([]),
  asOf: z.string().optional(),
});

export const NodeData = z.discriminatedUnion("kind", [
  ComponentData,
  DecisionData,
  RequirementData,
  AssumptionData,
  ResearchData,
]);
export type NodeData = z.infer<typeof NodeData>;

export const Position = z.object({ x: z.number(), y: z.number() });
export type Position = z.infer<typeof Position>;

export const Node = z.object({
  id: z.string(),
  kind: NodeKind,
  branchId: z.string(),
  depth: z.number().int().min(0),
  label: z.string(),
  description: z.string().default(""),
  parentId: z.string().optional(),
  version: z.number().int().default(0),
  pinned: z.boolean().default(false),
  pinnedPosition: Position.optional(),
  createdAt: z.number(),
  data: NodeData,
});
export type Node = z.infer<typeof Node>;

// ── Edges ─────────────────────────────────────────────────────────────

export const EdgeType = z.enum(["flows", "depends_on", "resolves", "satisfies", "child_of", "informs"]);
export type EdgeType = z.infer<typeof EdgeType>;

export const Edge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  type: EdgeType,
  label: z.string().optional(),
  sync: z.boolean().optional(),
  protocol: z.string().optional(),
});
export type Edge = z.infer<typeof Edge>;

// ── Ops: exactly seven. No coordinates, ever. ─────────────────────────

const NodeInput = Node.omit({ version: true, createdAt: true }).partial({
  description: true,
  pinned: true,
  depth: true,
  branchId: true,
});

export const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addNode"), node: NodeInput }),
  z.object({
    op: z.literal("updateNode"),
    id: z.string(),
    patch: z.object({
      label: z.string().optional(),
      description: z.string().optional(),
      pinned: z.boolean().optional(),
      pinnedPosition: Position.nullable().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({ op: z.literal("removeNode"), id: z.string() }),
  z.object({ op: z.literal("addEdge"), edge: Edge.omit({ id: true }).extend({ id: z.string().optional() }) }),
  z.object({ op: z.literal("removeEdge"), id: z.string() }),
  z.object({
    op: z.literal("openDecision"),
    id: z.string().optional(),
    parentId: z.string().optional(),
    branchId: z.string().optional(),
    question: z.string(),
    options: z.array(z.string()).optional(),
  }),
  z.object({
    op: z.literal("resolveDecision"),
    id: z.string(),
    chosen: z.string(),
    rationale: z.string(),
  }),
]);
export type Op = z.infer<typeof Op>;
export type OpInput = z.input<typeof Op>;

export const Origin = z.enum(["agent", "human", "system"]);
export type Origin = z.infer<typeof Origin>;

export const Role = z.enum([
  "orchestrator",
  "expander",
  "researcher",
  "critic",
  "scorer",
  "vision",
  "human",
  "system",
]);
export type Role = z.infer<typeof Role>;

export const OpBatch = z.object({
  id: z.string(),
  agentId: z.string(),
  role: Role,
  origin: Origin,
  parentDecisionId: z.string().optional(),
  baseVersions: z.record(z.string(), z.number()).default({}),
  ops: z.array(Op),
  reasoning: z.string().optional(),
  ts: z.number(),
});
export type OpBatch = z.infer<typeof OpBatch>;

// ── Scoring ───────────────────────────────────────────────────────────

export const SCORE_DIMS = [
  "coverage",
  "complexity",
  "cost",
  "latency",
  "availability",
  "consistency",
  "operability",
] as const;
export type ScoreDim = (typeof SCORE_DIMS)[number];

export const ScoreVector = z.object(
  Object.fromEntries(SCORE_DIMS.map((d) => [d, z.number().min(0).max(10)])) as Record<
    ScoreDim,
    z.ZodNumber
  >,
);
export type ScoreVector = z.infer<typeof ScoreVector>;

export const BranchScore = z.object({
  branchId: z.string(),
  vector: ScoreVector,
  justification: z.record(z.string(), z.string()).default({}),
  weakRationale: z.array(z.string()).default([]),
  scalar: z.number(),
  ts: z.number(),
});
export type BranchScore = z.infer<typeof BranchScore>;

export const Profile = z.object({
  weights: z
    .object(Object.fromEntries(SCORE_DIMS.map((d) => [d, z.number().min(0).default(1)])) as Record<ScoreDim, z.ZodDefault<z.ZodNumber>>)
    .default({} as never),
  notes: z.string().optional(),
});
export type Profile = z.infer<typeof Profile>;

// ── Run ───────────────────────────────────────────────────────────────

export const RunStatus = z.enum(["idle", "running", "paused", "halted"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const HaltReason = z.enum(["frontier_empty", "plateau", "budget", "node_limit", "human", "error"]);
export type HaltReason = z.infer<typeof HaltReason>;

export const Limits = z.object({
  maxNodes: z.number().int().positive(),
  maxDepth: z.number().int().positive(),
  maxChildrenPerDecision: z.number().int().positive().default(6),
});
export type Limits = z.infer<typeof Limits>;
