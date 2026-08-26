import { branchSummary, type DesignGraph } from "./graph.js";
import { openDecisions } from "./frontier.js";
import type { BranchScore, Node } from "./schema.js";

/**
 * Which open decision to work on next.
 *
 * Two separate jobs, deliberately kept apart:
 *
 *  - `priority()` ranks decisions by how much resolving one is worth.
 *  - `stratify()` decides how many workers each depth band gets.
 *
 * Ranking alone always favours shallow decisions — they have more hanging off them, so
 * every leverage-shaped score puts them on top, and the design grows wide and stays thin.
 * Reserving slots per depth band forces depth and breadth to advance at the same time
 * structurally, instead of hoping a weighting produces it.
 */

export interface PriorityContext {
  graph: DesignGraph;
  scores: Map<string, BranchScore>;
}

export interface ScoredDecision {
  node: Node;
  score: number;
  why: string;
}

export function priority(d: Node, ctx: PriorityContext): ScoredDecision {
  if (d.data.kind !== "decision") return { node: d, score: 0, why: "not a decision" };
  const reasons: string[] = [];
  let score = 0;

  // Coverage pressure: a branch with requirements nothing satisfies needs design work
  // more than one that is already well covered.
  const summary = branchSummary(ctx.graph, d.branchId);
  const unmet = summary.requirements.filter((r) => (summary.satisfied[r.id]?.length ?? 0) === 0).length;
  if (summary.requirements.length) {
    const gap = unmet / summary.requirements.length;
    score += gap * 4;
    if (gap > 0.4) reasons.push(`${unmet} unmet requirements`);
  }

  // A decision with real alternatives is a genuine fork; one with none is bookkeeping.
  if (d.data.options.length >= 2) {
    score += 2;
    reasons.push(`${d.data.options.length} options`);
  }

  // Invest where the design is already working. Neutral at 5/10 so an unscored branch
  // is neither favoured nor starved.
  const branch = ctx.scores.get(d.branchId);
  if (branch) {
    score += (branch.scalar - 5) * 0.3;
    if (branch.scalar >= 7) reasons.push(`strong branch (${branch.scalar.toFixed(1)})`);
  }

  // Something that has already failed twice is unlikely to succeed on a busy pool.
  score -= d.data.attempts * 1.5;
  if (d.data.attempts) reasons.push(`${d.data.attempts} prior attempts`);

  // Gentle age preference so nothing sits in the queue forever.
  score += Math.min(1, (Date.now() - d.createdAt) / 600_000);

  return { node: d, score, why: reasons.join(", ") || "routine" };
}

/** Depth bands. `deep` is unbounded upward so new depth is always reachable. */
export const BANDS = [
  { name: "shallow", min: 0, max: 1, share: 0.35 },
  { name: "mid", min: 2, max: 3, share: 0.35 },
  { name: "deep", min: 4, max: Infinity, share: 0.3 },
] as const;

/**
 * Pick up to `slots` decisions, reserving capacity per depth band and ranking within each.
 * Unused capacity in an empty band spills to the others, so a young run (nothing deep yet)
 * still uses every worker.
 */
export function stratify(ctx: PriorityContext, slots: number, exclude: Set<string>): ScoredDecision[] {
  const open = openDecisions(ctx.graph)
    .filter((d) => !exclude.has(d.id))
    .map((d) => priority(d, ctx));

  const byBand = BANDS.map((b) => ({
    band: b,
    items: open.filter((s) => s.node.depth >= b.min && s.node.depth <= b.max).sort((a, b2) => b2.score - a.score),
  }));

  const picked: ScoredDecision[] = [];
  const taken = new Set<string>();

  // First pass: each band takes its reserved share.
  for (const { band, items } of byBand) {
    const quota = Math.max(1, Math.round(slots * band.share));
    for (const item of items.slice(0, quota)) {
      if (picked.length >= slots) break;
      picked.push(item);
      taken.add(item.node.id);
    }
  }

  // Second pass: spill leftover capacity to whatever is best overall.
  if (picked.length < slots) {
    for (const item of open.sort((a, b) => b.score - a.score)) {
      if (picked.length >= slots) break;
      if (taken.has(item.node.id)) continue;
      picked.push(item);
      taken.add(item.node.id);
    }
  }

  return picked.slice(0, slots);
}

/** Deepest open decision, used to report how far the design has actually pushed. */
export function depthReached(g: DesignGraph): number {
  return Math.max(0, ...[...g.nodes.values()].map((n) => n.depth));
}
