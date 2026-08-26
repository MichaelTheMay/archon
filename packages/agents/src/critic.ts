import type { BranchSummary, Op } from "@archon/core";
import type { Provider } from "./provider.js";

/**
 * v1. The Critic attacks a branch and opens decisions for the holes it finds —
 * it never deletes another agent's work. Interface is fixed now so the orchestrator
 * can be wired against it; the implementation lands with the Critic milestone.
 */
export interface Critic {
  attack(provider: Provider, summary: BranchSummary): Promise<Op[]>;
}

export const notImplementedCritic: Critic = {
  async attack() {
    throw new Error("Critic not implemented (v1)");
  },
};
