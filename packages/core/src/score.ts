import { SCORE_DIMS, type BranchScore, type Profile, type ScoreVector } from "./schema.js";

export function weightedScore(vec: ScoreVector, profile: Profile): number {
  let num = 0;
  let den = 0;
  for (const d of SCORE_DIMS) {
    const w = profile.weights[d] ?? 1;
    num += vec[d] * w;
    den += w;
  }
  return den === 0 ? 0 : num / den;
}

export function defaultProfile(): Profile {
  return {
    weights: Object.fromEntries(SCORE_DIMS.map((d) => [d, 1])) as Profile["weights"],
  };
}

/**
 * Branches to prune: scalar below median − 1.5σ. Never pinned branches.
 * Requires ≥3 scored branches to be meaningful.
 */
export function pruneCandidates(scores: BranchScore[], pinnedBranches: Set<string>): string[] {
  const eligible = scores.filter((s) => !pinnedBranches.has(s.branchId));
  if (eligible.length < 3) return [];
  const xs = eligible.map((s) => s.scalar).sort((a, b) => a - b);
  const median = xs.length % 2 ? xs[(xs.length - 1) / 2]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const cutoff = median - 1.5 * sd;
  return eligible.filter((s) => s.scalar < cutoff).map((s) => s.branchId);
}

/** Plateau: best score changed by < epsilon across the last `window` rounds. */
export function isPlateau(bestHistory: number[], window = 3, epsilon = 0.2): boolean {
  if (bestHistory.length < window + 1) return false;
  const recent = bestHistory.slice(-(window + 1));
  return Math.max(...recent) - Math.min(...recent) < epsilon;
}
