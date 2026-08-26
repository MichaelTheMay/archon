import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BranchScore, OpBatch, Usage } from "@archon/core";
import type { ResponseCache } from "@archon/agents";

export interface RunRow {
  id: string;
  idea: string;
  notes: string | null;
  status: string;
  haltReason: string | null;
  createdAt: number;
  updatedAt: number;
  spentUsd: number;
}

/**
 * Append-only op-log. This is the whole trust story: every batch, every LLM call and
 * every score is recorded in order, so any run replays deterministically — which is
 * both crash recovery and the time-travel scrubber.
 */
export class OpLog {
  private db: Database.Database;

  constructor(dataDir: string) {
    const file = join(dataDir, "archon.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, idea TEXT NOT NULL, notes TEXT,
        status TEXT NOT NULL, haltReason TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        spentUsd REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS batches (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        runId TEXT NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS batches_run ON batches(runId, seq);
      CREATE TABLE IF NOT EXISTS llm_calls (
        cacheKey TEXT PRIMARY KEY, runId TEXT NOT NULL, role TEXT NOT NULL,
        model TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL,
        inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL, ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scores (
        runId TEXT NOT NULL, branchId TEXT NOT NULL, seq INTEGER NOT NULL,
        json TEXT NOT NULL, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scores_run ON scores(runId, ts);
    `);
  }

  createRun(id: string, idea: string, notes?: string): void {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO runs (id, idea, notes, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?)`)
      .run(id, idea, notes ?? null, "idle", now, now);
  }

  setStatus(runId: string, status: string, haltReason?: string | null, spentUsd?: number): void {
    this.db
      .prepare(`UPDATE runs SET status=?, haltReason=?, updatedAt=?, spentUsd=COALESCE(?, spentUsd) WHERE id=?`)
      .run(status, haltReason ?? null, Date.now(), spentUsd ?? null, runId);
  }

  getRun(runId: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id=?`).get(runId) as RunRow | undefined;
  }

  listRuns(): RunRow[] {
    return this.db.prepare(`SELECT * FROM runs ORDER BY createdAt DESC`).all() as RunRow[];
  }

  /** Returns the assigned sequence number. Atomic. */
  appendBatch(runId: string, batch: OpBatch): number {
    const info = this.db
      .prepare(`INSERT INTO batches (runId, ts, json) VALUES (?,?,?)`)
      .run(runId, batch.ts, JSON.stringify(batch));
    return Number(info.lastInsertRowid);
  }

  batches(runId: string): { seq: number; batch: OpBatch }[] {
    const rows = this.db.prepare(`SELECT seq, json FROM batches WHERE runId=? ORDER BY seq`).all(runId) as {
      seq: number;
      json: string;
    }[];
    return rows.map((r) => ({ seq: r.seq, batch: JSON.parse(r.json) as OpBatch }));
  }

  appendScore(runId: string, seq: number, score: BranchScore): void {
    this.db
      .prepare(`INSERT INTO scores (runId, branchId, seq, json, ts) VALUES (?,?,?,?,?)`)
      .run(runId, score.branchId, seq, JSON.stringify(score), score.ts);
  }

  /** Latest score per branch. */
  scores(runId: string): BranchScore[] {
    const rows = this.db
      .prepare(`SELECT json FROM scores WHERE runId=? ORDER BY ts`)
      .all(runId) as { json: string }[];
    const latest = new Map<string, BranchScore>();
    for (const r of rows) {
      const s = JSON.parse(r.json) as BranchScore;
      latest.set(s.branchId, s);
    }
    return [...latest.values()];
  }

  scoreHistory(runId: string): BranchScore[] {
    return (this.db.prepare(`SELECT json FROM scores WHERE runId=? ORDER BY ts`).all(runId) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as BranchScore,
    );
  }

  /** Response cache backing MOCK_LLM replay — a run can be re-driven with zero API calls. */
  cacheFor(runId: string): ResponseCache {
    const get = this.db.prepare(`SELECT model, response, inputTokens, outputTokens FROM llm_calls WHERE cacheKey=?`);
    const set = this.db.prepare(
      `INSERT OR REPLACE INTO llm_calls (cacheKey, runId, role, model, request, response, inputTokens, outputTokens, ts)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    return {
      get(key) {
        const row = get.get(`${runId}:${key}`) as
          | { model: string; response: string; inputTokens: number; outputTokens: number }
          | undefined;
        if (!row) return undefined;
        return {
          object: JSON.parse(row.response),
          usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens } satisfies Usage,
          model: row.model,
        };
      },
      set(key, v) {
        set.run(
          `${runId}:${key}`,
          runId,
          v.role,
          v.model,
          v.request,
          JSON.stringify(v.object),
          v.usage.inputTokens,
          v.usage.outputTokens,
          Date.now(),
        );
      },
    };
  }

  close(): void {
    this.db.close();
  }
}
