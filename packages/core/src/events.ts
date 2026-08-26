import type { SerializedGraph } from "./graph.js";
import type { TimelineEntry } from "./replay.js";
import type { BranchScore, HaltReason, Node, OpBatch, Position, RunStatus } from "./schema.js";

export type LayoutSnapshot = {
  nodes: Record<string, Position & { w: number; h: number }>;
  branches: Record<string, Position & { w: number; h: number }>;
};

export type BudgetSnapshot = {
  spentUsd: number;
  limitUsd: number | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
};

export type RunEvent =
  | {
      type: "snapshot";
      graph: SerializedGraph;
      layout: LayoutSnapshot;
      scores: BranchScore[];
      status: RunStatus;
      haltReason?: HaltReason;
      budget: BudgetSnapshot;
      timeline: TimelineEntry[];
    }
  | { type: "batch"; batch: OpBatch; seq: number; entry: TimelineEntry; graph: SerializedGraph }
  | { type: "rejected"; batch: OpBatch; reason: string }
  | { type: "layout"; layout: LayoutSnapshot }
  | { type: "score"; score: BranchScore }
  | { type: "pruned"; branchIds: string[] }
  | { type: "frontier"; decisions: Node[]; inFlight: string[] }
  | { type: "status"; status: RunStatus; haltReason?: HaltReason; budget: BudgetSnapshot }
  | { type: "agent"; agentId: string; role: string; state: "start" | "end" | "error"; decisionId?: string; message?: string }
  | { type: "error"; message: string };
