import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { Op, newId, type RunEvent } from "@archon/core";
import { Provider } from "@archon/agents";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { OpLog } from "./oplog.js";
import { Run } from "./orchestrator.js";

const CreateRun = z.object({ idea: z.string().min(3), notes: z.string().optional(), autostart: z.boolean().default(true) });
const HumanOps = z.object({ ops: z.array(Op).min(1), reasoning: z.string().optional() });

export function createApp(cfg: Config, log: OpLog, logger: Logger) {
  const app = new Hono();
  const runs = new Map<string, Run>();

  const provider = (runId: string) =>
    new Provider({
      apiKey: cfg.XAI_API_KEY,
      models: cfg.models,
      mock: cfg.MOCK_LLM === 1,
      cache: log.cacheFor(runId),
    });

  async function getRun(id: string): Promise<Run | undefined> {
    const live = runs.get(id);
    if (live) return live;
    const row = log.getRun(id);
    if (!row) return undefined;
    const run = new Run(row.id, row.idea, cfg, log, logger, provider(row.id), row.notes ?? undefined);
    await run.hydrate();
    run.status = row.status === "running" ? "paused" : (row.status as typeof run.status);
    runs.set(id, run);
    return run;
  }

  // Mutations are gated in prod when ADMIN_TOKEN is set. Both patterns are needed:
  // "/api/runs/*" does not match "/api/runs" itself, which is where runs are created.
  const guard = async (c: Parameters<Parameters<typeof app.use>[1]>[0], next: () => Promise<void>) => {
    if (!cfg.ADMIN_TOKEN || c.req.method === "GET") return next();
    if (c.req.header("authorization") !== `Bearer ${cfg.ADMIN_TOKEN}`) return c.json({ error: "unauthorized" }, 401);
    return next();
  };
  app.use("/api/runs", guard);
  app.use("/api/runs/*", guard);

  app.get("/api/health", (c) => c.json({ ok: true, env: cfg.NODE_ENV, mock: cfg.MOCK_LLM === 1 }));

  app.get("/api/runs", (c) => c.json({ runs: log.listRuns() }));

  app.post("/api/runs", async (c) => {
    const body = CreateRun.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    const id = newId("run");
    log.createRun(id, body.data.idea, body.data.notes);
    const run = new Run(id, body.data.idea, cfg, log, logger, provider(id), body.data.notes);
    runs.set(id, run);
    if (body.data.autostart) run.start();
    return c.json({ id, status: run.status }, 201);
  });

  app.get("/api/runs/:id", async (c) => {
    const run = await getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json(run.snapshot());
  });

  /** Live stream: current state first, then every event as it happens. */
  app.get("/api/runs/:id/events", async (c) => {
    const run = await getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    return streamSSE(c, async (stream) => {
      const queue: RunEvent[] = [run.snapshot()];
      let notify: (() => void) | undefined;
      const unsubscribe = run.subscribe((e) => {
        queue.push(e);
        notify?.();
      });
      c.req.raw.signal.addEventListener("abort", () => {
        unsubscribe();
        notify?.();
      });
      try {
        while (!c.req.raw.signal.aborted) {
          while (queue.length) {
            const e = queue.shift()!;
            await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
          }
          await new Promise<void>((r) => {
            notify = r;
            setTimeout(r, 15_000); // keepalive tick
          });
          notify = undefined;
          if (!queue.length && !c.req.raw.signal.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  /** Time travel: the graph as it stood after `seq` batches. Powers the replay scrubber. */
  app.get("/api/runs/:id/at/:seq", async (c) => {
    const run = await getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const seq = Number(c.req.param("seq"));
    if (!Number.isFinite(seq)) return c.json({ error: "bad seq" }, 400);
    return c.json(await run.graphAt(seq));
  });

  for (const action of ["start", "resume", "pause", "step"] as const) {
    app.post(`/api/runs/:id/${action}`, async (c) => {
      const run = await getRun(c.req.param("id"));
      if (!run) return c.json({ error: "not found" }, 404);
      if (action === "pause") run.pause();
      else if (action === "step") run.step();
      else run.start();
      return c.json({ status: run.status });
    });
  }

  /** Human control surface: pin, kill, inject, steer — all expressed as ops. */
  app.post("/api/runs/:id/ops", async (c) => {
    const run = await getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const body = HumanOps.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    const ok = await run.humanOps(body.data.ops, body.data.reasoning);
    return c.json({ ok }, ok ? 200 : 409);
  });

  app.post("/api/runs/:id/budget", async (c) => {
    const run = await getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not found" }, 404);
    const body = z.object({ usd: z.number().nullable() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    run.setBudget(body.data.usd);
    return c.json({ budget: run.budget.snapshot() });
  });

  return { app, runs };
}
