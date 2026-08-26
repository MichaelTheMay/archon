import { z } from "zod";

const num = (d: number) => z.coerce.number().default(d);

const Env = z.object({
  XAI_API_KEY: z.string().min(1, "XAI_API_KEY is required (copy .env.example to .env)"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: num(8787),
  MODEL_ORCHESTRATOR: z.string().default("grok-4.6"),
  MODEL_EXPANDER: z.string().default("grok-4.5"),
  MODEL_RESEARCHER: z.string().default("grok-4.6"),
  MODEL_CRITIC: z.string().default("grok-4.6"),
  MODEL_SCORER: z.string().default("grok-4.6"),
  MAX_NODES: num(200),
  MAX_DEPTH: num(6),
  MAX_CONCURRENCY: num(3),
  MAX_CHILDREN_PER_DECISION: num(4),
  BUDGET_USD: z.coerce.number().nullable().default(2),
  RESEARCH_BUDGET_FRACTION: num(0.4),
  DATA_DIR: z.string().default("./data"),
  MOCK_LLM: z.coerce.number().default(0),
  ADMIN_TOKEN: z.string().default(""),
  WEB_DIST: z.string().default("../../apps/web/dist"),
});

export type Config = z.infer<typeof Env> & {
  isProd: boolean;
  models: Record<string, string>;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${msg}`);
  }
  const c = parsed.data;
  return {
    ...c,
    isProd: c.NODE_ENV === "production",
    models: {
      orchestrator: c.MODEL_ORCHESTRATOR,
      expander: c.MODEL_EXPANDER,
      researcher: c.MODEL_RESEARCHER,
      critic: c.MODEL_CRITIC,
      scorer: c.MODEL_SCORER,
    },
  };
}
