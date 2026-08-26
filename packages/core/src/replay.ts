import { emptyGraph, type DesignGraph } from "./graph.js";
import { applyBatch } from "./reducer.js";
import type { Limits, OpBatch } from "./schema.js";

export interface TimelineEntry {
  seq: number;
  ts: number;
  role: string;
  origin: string;
  agentId: string;
  opCount: number;
  reasoning?: string;
  decisionId?: string;
}

/** Metadata for the scrubber, without shipping every op to the client. */
export function timeline(batches: { seq: number; batch: OpBatch }[]): TimelineEntry[] {
  return batches.map(({ seq, batch }) => ({
    seq,
    ts: batch.ts,
    role: batch.role,
    origin: batch.origin,
    agentId: batch.agentId,
    opCount: batch.ops.length,
    ...(batch.reasoning ? { reasoning: batch.reasoning } : {}),
    ...(batch.parentDecisionId ? { decisionId: batch.parentDecisionId } : {}),
  }));
}

/**
 * Rebuild the graph as it stood after `throughSeq` batches (inclusive).
 * This is both crash-recovery and the time-travel scrubber: same code path.
 * Replay never rejects — batches in the log were already accepted once — but a
 * rejection is surfaced rather than silently skipped.
 */
export function replayTo(
  batches: { seq: number; batch: OpBatch }[],
  throughSeq: number,
  limits: Limits,
): { graph: DesignGraph; applied: number; errors: string[] } {
  let graph = emptyGraph();
  const errors: string[] = [];
  let applied = 0;
  for (const { seq, batch } of batches) {
    if (seq > throughSeq) break;
    // replay is authoritative: the log is the truth, so bypass optimistic checks
    const r = applyBatch(graph, { ...batch, baseVersions: {} }, limits);
    if (r.ok) {
      graph = r.graph;
      applied += 1;
    } else {
      errors.push(`seq ${seq}: ${r.rejected.reason}`);
    }
  }
  return { graph, applied, errors };
}
