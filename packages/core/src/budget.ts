export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** USD per 1M tokens. Override via PRICE_<MODEL> env if xAI changes pricing. */
export const DEFAULT_PRICES: Record<string, { in: number; out: number }> = {
  "grok-4.6": { in: 2, out: 6 },
  "grok-4.5": { in: 2, out: 6 },
  "grok-build-0.1": { in: 2, out: 6 },
};

export function estimateCost(model: string, usage: Usage, prices = DEFAULT_PRICES): number {
  const p = prices[model] ?? { in: 2, out: 6 };
  return (usage.inputTokens * p.in + usage.outputTokens * p.out) / 1_000_000;
}

export class BudgetTracker {
  spentUsd = 0;
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  constructor(public limitUsd: number | null, private prices = DEFAULT_PRICES) {}

  record(model: string, usage: Usage): number {
    const c = estimateCost(model, usage, this.prices);
    this.spentUsd += c;
    this.calls += 1;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    return c;
  }

  exhausted(): boolean {
    return this.limitUsd !== null && this.spentUsd >= this.limitUsd;
  }

  snapshot() {
    return { spentUsd: this.spentUsd, limitUsd: this.limitUsd, calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }
}
