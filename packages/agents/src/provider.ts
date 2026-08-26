import { createXai } from "@ai-sdk/xai";
import { Output, generateText, stepCountIs, type ToolSet } from "ai";
import type { Role, Usage } from "@archon/core";
import type { z } from "zod";

export interface ResponseCache {
  get(key: string): { object: unknown; usage: Usage; model: string } | undefined;
  set(key: string, value: { object: unknown; usage: Usage; model: string; role: string; request: string }): void;
}

export interface ProviderConfig {
  apiKey: string;
  models: Record<string, string>;
  /** Replay recorded responses; never hit the network. */
  mock: boolean;
  cache?: ResponseCache;
  maxRetries?: number;
  /** Per-call wall clock. Tool-using research calls get a longer one. */
  timeoutMs?: number;
  toolTimeoutMs?: number;
  onRateLimit?: () => void;
}

export class RateLimited extends Error {}

const jitter = (ms: number) => ms * (0.5 + Math.random());

export class Provider {
  private xai: ReturnType<typeof createXai>;

  constructor(private cfg: ProviderConfig) {
    this.xai = createXai({ apiKey: cfg.apiKey });
  }

  modelFor(role: Role): string {
    return this.cfg.models[role] ?? this.cfg.models["orchestrator"] ?? "grok-4.6";
  }

  /**
   * One structured call. Optionally runs provider-executed tools (xAI web/X search)
   * for a few steps first, then forces a schema-shaped answer.
   */
  async structured<T>(args: {
    role: Role;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    cacheKey: string;
    tools?: ToolSet;
    maxSteps?: number;
  }): Promise<{ object: T; usage: Usage; model: string; cached: boolean }> {
    const model = this.modelFor(args.role);
    const cached = this.cfg.cache?.get(args.cacheKey);
    if (cached) {
      return { object: cached.object as T, usage: cached.usage, model: cached.model, cached: true };
    }
    if (this.cfg.mock) {
      throw new Error(`MOCK_LLM=1 but no recorded response for ${args.cacheKey}`);
    }

    const maxRetries = this.cfg.maxRetries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await generateText({
          model: this.xai(model),
          system: args.system,
          prompt: args.prompt,
          output: Output.object({ schema: args.schema }),
          maxRetries: 0, // we own the retry loop
          // Without this a stalled connection hangs the orchestrator forever: the loop
          // awaits the call, so one dead socket silently parks the whole run.
          timeout: args.tools ? (this.cfg.toolTimeoutMs ?? 240_000) : (this.cfg.timeoutMs ?? 120_000),
          ...(args.tools ? { tools: args.tools, stopWhen: stepCountIs(args.maxSteps ?? 6) } : {}),
        });
        const usage: Usage = {
          inputTokens: res.usage?.inputTokens ?? 0,
          outputTokens: res.usage?.outputTokens ?? 0,
        };
        const object = res.output as T;
        this.cfg.cache?.set(args.cacheKey, {
          object,
          usage,
          model,
          role: args.role,
          request: JSON.stringify({ system: args.system, prompt: args.prompt }),
        });
        return { object, usage, model, cached: false };
      } catch (err) {
        lastErr = err;
        const msg = String((err as Error)?.message ?? err);
        const rateLimited = /429|rate.?limit/i.test(msg);
        if (rateLimited) this.cfg.onRateLimit?.();
        if (attempt === maxRetries - 1) break;
        await new Promise((r) => setTimeout(r, jitter(500 * 2 ** attempt)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
