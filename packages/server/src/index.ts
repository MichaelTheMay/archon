import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loadConfig } from "./config.js";
import { OpLog } from "./oplog.js";
import { createApp } from "./routes.js";

const cfg = loadConfig();

const logger = pino(
  cfg.isProd
    ? { level: "info" }
    : { level: "debug", transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } },
);

const log = new OpLog(cfg.DATA_DIR);
const { app } = createApp(cfg, log, logger);

// In production the server also serves the built canvas; in dev, Vite does.
// Resolve relative to this module, not cwd — `pnpm start` runs from the repo root.
const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, cfg.WEB_DIST);
if (cfg.isProd) {
  if (existsSync(webDist)) {
    // serveStatic wants a path relative to cwd.
    const root = relative(process.cwd(), webDist) || ".";
    app.use("/*", serveStatic({ root }));
    app.get("/*", serveStatic({ path: `${root}/index.html` }));
    logger.info({ webDist }, "serving web build");
  } else {
    logger.warn({ webDist }, "no web build found; API only. Run `pnpm build` first.");
  }
}

// A run marked running in the log was interrupted; park it as paused so a human decides.
for (const row of log.listRuns()) {
  if (row.status === "running") {
    log.setStatus(row.id, "paused", null);
    logger.warn({ runId: row.id }, "run was interrupted; parked as paused");
  }
}

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  logger.info(
    { port: info.port, env: cfg.NODE_ENV, mock: cfg.MOCK_LLM === 1, models: cfg.models },
    "archon server up",
  );
});

const shutdown = () => {
  logger.info("shutting down");
  server.close(() => {
    log.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
