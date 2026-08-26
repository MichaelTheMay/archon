import {
  BudgetTracker,
  applyBatch,
  branchIds,
  branchSummary,
  defaultProfile,
  emptyGraph,
  isPlateau,
  localContext,
  newId,
  openDecisions,
  pruneCandidates,
  replayTo,
  serializeGraph,
  timeline,
  weightedScore,
  type BranchScore,
  type DesignGraph,
  type HaltReason,
  type LayoutSnapshot,
  type Limits,
  type Node,
  type Op,
  type OpBatch,
  type Profile,
  type RunEvent,
  type RunStatus,
} from "@archon/core";
import {
  Provider,
  compileIntakeOps,
  compileOps,
  compileResearchOps,
  researchFor,
  runExpander,
  runIntake,
  runResearcher,
  runScorer,
} from "@archon/agents";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { layoutGraph } from "./layout.js";
import type { OpLog } from "./oplog.js";

const SCORE_EVERY = 4;

export class Run {
  graph: DesignGraph = emptyGraph();
  layout: LayoutSnapshot = { nodes: {}, branches: {} };
  status: RunStatus = "idle";
  haltReason?: HaltReason;
  budget: BudgetTracker;
  profile: Profile = defaultProfile();
  inFlight = new Set<string>();
  private subscribers = new Set<(e: RunEvent) => void>();
  private limits: Limits;
  private concurrency: number;
  private commitsSinceScore = 0;
  private bestHistory: number[] = [];
  private lastSeq = 0;
  private loopPromise?: Promise<void>;
  private stepOnce = false;
  private lastRateLimit = 0;

  constructor(
    readonly id: string,
    readonly idea: string,
    private cfg: Config,
    private log: OpLog,
    private logger: Logger,
    private provider: Provider,
    private notes?: string,
  ) {
    this.limits = {
      maxNodes: cfg.MAX_NODES,
      maxDepth: cfg.MAX_DEPTH,
      maxChildrenPerDecision: cfg.MAX_CHILDREN_PER_DECISION,
    };
    this.concurrency = cfg.MAX_CONCURRENCY;
    this.budget = new BudgetTracker(cfg.BUDGET_USD);
  }

  // ── wiring ──────────────────────────────────────────────────────────

  subscribe(fn: (e: RunEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(e: RunEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(e);
      } catch (err) {
        this.logger.warn({ err }, "subscriber threw");
      }
    }
  }

  snapshot(): Extract<RunEvent, { type: "snapshot" }> {
    return {
      type: "snapshot",
      graph: serializeGraph(this.graph),
      layout: this.layout,
      scores: this.log.scores(this.id),
      status: this.status,
      ...(this.haltReason ? { haltReason: this.haltReason } : {}),
      budget: this.budget.snapshot(),
      timeline: timeline(this.log.batches(this.id)),
    };
  }

  /** Rebuild from the op-log — crash recovery and the time-travel scrubber, same path. */
  async hydrate(): Promise<void> {
    const batches = this.log.batches(this.id);
    if (!batches.length) return;
    const { graph, errors } = replayTo(batches, Infinity, this.limits);
    this.graph = graph;
    // Without this the canvas is blank after a restart: nothing commits while paused,
    // so no layout event is ever emitted.
    this.layout = await layoutGraph(serializeGraph(graph));
    this.lastSeq = batches[batches.length - 1]!.seq;
    if (errors.length) this.logger.warn({ errors }, "replay produced rejections");
    const row = this.log.getRun(this.id);
    if (row) this.budget.spentUsd = row.spentUsd;
    this.bestHistory = this.log.scoreHistory(this.id).map((s) => s.scalar);
  }

  /** Graph as of a point in the log, for the replay scrubber. Does not touch live state. */
  async graphAt(seq: number) {
    const { graph } = replayTo(this.log.batches(this.id), seq, this.limits);
    const s = serializeGraph(graph);
    return { graph: s, layout: await layoutGraph(s) };
  }

  // ── commit path: the only way the graph changes ─────────────────────

  private async commit(batch: OpBatch): Promise<boolean> {
    const res = applyBatch(this.graph, batch, this.limits);
    if (!res.ok) {
      this.logger.warn({ reason: res.rejected.reason, role: batch.role }, "batch rejected");
      this.emit({ type: "rejected", batch, reason: res.rejected.reason });
      return false;
    }
    this.graph = res.graph;
    const seq = this.log.appendBatch(this.id, batch);
    this.lastSeq = seq;
    const graph = serializeGraph(this.graph);
    const entry = timeline([{ seq, batch }])[0]!;
    this.emit({ type: "batch", batch, seq, entry, graph });
    this.layout = await layoutGraph(graph);
    this.emit({ type: "layout", layout: this.layout });
    this.emitFrontier();
    return true;
  }

  private emitFrontier(): void {
    this.emit({ type: "frontier", decisions: openDecisions(this.graph), inFlight: [...this.inFlight] });
  }

  private emitStatus(): void {
    this.log.setStatus(this.id, this.status, this.haltReason ?? null, this.budget.spentUsd);
    this.emit({
      type: "status",
      status: this.status,
      ...(this.haltReason ? { haltReason: this.haltReason } : {}),
      budget: this.budget.snapshot(),
    });
  }

  /** Human ops: pin, kill, inject, steer. Always win over in-flight agent work. */
  async humanOps(ops: Op[], reasoning?: string): Promise<boolean> {
    return this.commit({
      id: newId("b"),
      agentId: "human",
      role: "human",
      origin: "human",
      baseVersions: {},
      ops,
      ts: Date.now(),
      ...(reasoning ? { reasoning } : {}),
    });
  }

  // ── control ─────────────────────────────────────────────────────────

  start(): void {
    if (this.status === "running") return;
    this.status = "running";
    delete this.haltReason;
    this.emitStatus();
    this.loopPromise = this.loop().catch((err) => {
      this.logger.error({ err }, "loop crashed");
      this.status = "halted";
      this.haltReason = "error";
      this.emit({ type: "error", message: String((err as Error)?.message ?? err) });
      this.emitStatus();
    });
  }

  pause(): void {
    if (this.status !== "running") return;
    this.status = "paused";
    this.emitStatus();
  }

  step(): void {
    this.stepOnce = true;
    if (this.status !== "running") this.start();
  }

  halt(reason: HaltReason): void {
    this.status = "halted";
    this.haltReason = reason;
    this.emitStatus();
  }

  setBudget(usd: number | null): void {
    this.budget.limitUsd = usd;
    this.emitStatus();
  }

  async settle(): Promise<void> {
    await this.loopPromise;
  }

  // ── the loop ────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    if (this.graph.nodes.size === 0) {
      await this.intake();
    }

    while (this.status === "running") {
      if (this.budget.exhausted()) return this.halt("budget");
      if (this.graph.nodes.size >= this.limits.maxNodes) return this.halt("node_limit");

      const frontier = openDecisions(this.graph).filter((d) => !this.inFlight.has(d.id));
      if (!frontier.length) {
        if (this.inFlight.size === 0) return this.halt("frontier_empty");
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      const slots = Math.max(0, this.concurrency - this.inFlight.size);
      const wave = frontier.slice(0, Math.max(1, slots));
      await Promise.all(wave.map((d) => this.expandOne(d)));

      this.commitsSinceScore += wave.length;
      if (this.commitsSinceScore >= SCORE_EVERY) {
        this.commitsSinceScore = 0;
        await this.scoreAndPrune();
        // Plateau only means convergence when there are rival branches to converge
        // between. With a single region a flat score just means the scorer is coarse,
        // so halting on it would masquerade as success with a full frontier.
        if (branchIds(this.graph).length > 1 && isPlateau(this.bestHistory)) return this.halt("plateau");
      }

      if (this.stepOnce) {
        this.stepOnce = false;
        this.pause();
      }
    }
  }

  private async intake(): Promise<void> {
    this.emit({ type: "agent", agentId: "intake", role: "orchestrator", state: "start" });
    const { output, usage, model } = await runIntake(this.provider, this.idea, this.notes);
    this.budget.record(model, usage);
    const ok = await this.commit({
      id: newId("b"),
      agentId: "intake",
      role: "orchestrator",
      origin: "system",
      baseVersions: {},
      ops: compileIntakeOps(output, "main", {
        maxRootDecisions: this.limits.maxChildrenPerDecision,
        // Framing gets at most 40% of the node budget; the rest is for the design itself.
        maxNodes: Math.max(6, Math.floor(this.limits.maxNodes * 0.4)),
      }),
      reasoning: `Framed "${output.title}": ${output.requirements.length} requirements, ${output.rootDecisions.length} root decisions`,
      ts: Date.now(),
    });
    // Fail loudly: a silently rejected intake leaves an empty graph, and the loop would
    // then halt as "frontier_empty" — which reads like success.
    if (!ok) throw new Error("intake batch was rejected; cannot start run");
    this.emit({ type: "agent", agentId: "intake", role: "orchestrator", state: "end" });
    this.emitStatus();
  }

  /**
   * Expand one decision. If the Expander flags the decision as depending on facts that
   * move, a Researcher runs first (live search) and the Expander is re-run with its
   * findings in context — so the design choice is made against what is actually true now.
   */
  private async expandOne(decision: Node): Promise<void> {
    const agentId = newId("ag");
    this.inFlight.add(decision.id);
    this.emitFrontier();
    this.emit({ type: "agent", agentId, role: "expander", state: "start", decisionId: decision.id });

    try {
      let ctx = localContext(this.graph, decision.id);
      let research = researchFor([...this.graph.nodes.values()], decision.id);
      let baseVersions = this.versionsFor(ctx);

      let { output, usage, model } = await runExpander(this.provider, ctx, research, agentId);
      this.budget.record(model, usage);

      if (output.needsResearch && output.researchQuery && this.researchAffordable()) {
        this.emit({ type: "agent", agentId, role: "researcher", state: "start", decisionId: decision.id, message: output.researchQuery });
        const r = await runResearcher(this.provider, output.researchQuery, ctx);
        this.budget.record(r.model, r.usage);
        const { ops } = compileResearchOps(ctx, output.researchQuery, r.output);
        await this.commit({
          id: newId("b"),
          agentId,
          role: "researcher",
          origin: "agent",
          parentDecisionId: decision.id,
          baseVersions,
          ops,
          reasoning: r.output.recommendation,
          ts: Date.now(),
        });
        this.emit({ type: "agent", agentId, role: "researcher", state: "end", decisionId: decision.id });

        // re-run the expander with the findings in hand
        ctx = localContext(this.graph, decision.id);
        research = researchFor([...this.graph.nodes.values()], decision.id);
        baseVersions = this.versionsFor(ctx);
        const second = await runExpander(this.provider, ctx, research, agentId);
        this.budget.record(second.model, second.usage);
        output = second.output;
      }

      const ok = await this.commit({
        id: newId("b"),
        agentId,
        role: "expander",
        origin: "agent",
        parentDecisionId: decision.id,
        baseVersions,
        ops: compileOps(ctx, output, this.childBudgetFor(decision.id)),
        reasoning: output.rationale,
        ts: Date.now(),
      });

      if (!ok) await this.bumpAttempts(decision);
      this.emit({ type: "agent", agentId, role: "expander", state: "end", decisionId: decision.id });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      this.logger.error({ err, decisionId: decision.id }, "expander failed");
      if (/429|rate.?limit/i.test(msg)) this.throttle();
      await this.bumpAttempts(decision);
      this.emit({ type: "agent", agentId, role: "expander", state: "error", decisionId: decision.id, message: msg });
    } finally {
      this.inFlight.delete(decision.id);
      this.emitFrontier();
      this.emitStatus();
    }
  }

  /**
   * How many more child decisions this parent can take.
   *
   * Tapered by depth: breadth-first expansion over decisions opens new questions faster
   * than it closes them, so a flat cap means the frontier never empties and every run
   * terminates on budget rather than on convergence. Allowance shrinks with depth and
   * reaches zero at the depth limit, which forces the tree to close itself.
   */
  private childBudgetFor(parentId: string): number {
    const parent = this.graph.nodes.get(parentId);
    const depth = parent?.depth ?? 0;
    const existing = [...this.graph.nodes.values()].filter((n) => n.parentId === parentId && n.kind === "decision").length;
    const taper = Math.max(0, this.limits.maxChildrenPerDecision - depth);
    const atDepthLimit = depth + 1 >= this.limits.maxDepth;
    return atDepthLimit ? 0 : Math.max(0, Math.min(taper, this.limits.maxChildrenPerDecision - existing));
  }

  private versionsFor(ctx: ReturnType<typeof localContext>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const n of [ctx.decision, ...ctx.components, ...ctx.spine]) out[n.id] = n.version;
    return out;
  }

  /** Cap research spend so a curious run cannot burn the whole budget on searches. */
  private researchAffordable(): boolean {
    if (this.budget.limitUsd === null) return true;
    return this.budget.spentUsd < this.budget.limitUsd * this.cfg.RESEARCH_BUDGET_FRACTION;
  }

  private throttle(): void {
    const now = Date.now();
    if (now - this.lastRateLimit < 5_000) return;
    this.lastRateLimit = now;
    this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
    this.logger.warn({ concurrency: this.concurrency }, "rate limited: halving concurrency");
    setTimeout(() => {
      this.concurrency = Math.min(this.cfg.MAX_CONCURRENCY, this.concurrency + 1);
    }, 30_000);
  }

  /** Three strikes and the decision is parked as stalled, visible in the UI. */
  private async bumpAttempts(decision: Node): Promise<void> {
    const n = this.graph.nodes.get(decision.id);
    if (!n || n.data.kind !== "decision") return;
    const attempts = n.data.attempts + 1;
    await this.commit({
      id: newId("b"),
      agentId: "orchestrator",
      role: "system",
      origin: "system",
      baseVersions: {},
      ops: [{ op: "updateNode", id: decision.id, patch: { data: { attempts, status: attempts >= 3 ? "stalled" : "open" } } }],
      reasoning: attempts >= 3 ? "stalled after 3 failed attempts" : `retry ${attempts}/3`,
      ts: Date.now(),
    });
  }

  private async scoreAndPrune(): Promise<void> {
    const branches = branchIds(this.graph).filter((b) => branchSummary(this.graph, b).components.length > 0);
    if (!branches.length) return;

    const results = await Promise.all(
      branches.map(async (branchId): Promise<BranchScore | null> => {
        try {
          const summary = branchSummary(this.graph, branchId);
          const { output, usage, model } = await runScorer(this.provider, summary, this.lastSeq);
          this.budget.record(model, usage);
          const score: BranchScore = {
            branchId,
            vector: output.vector,
            justification: output.justification,
            weakRationale: output.weakRationale,
            scalar: weightedScore(output.vector, this.profile),
            ts: Date.now(),
          };
          this.log.appendScore(this.id, this.lastSeq, score);
          this.emit({ type: "score", score });
          return score;
        } catch (err) {
          this.logger.warn({ err, branchId }, "scorer failed");
          return null;
        }
      }),
    );

    const scores = results.filter((s): s is BranchScore => s !== null);
    if (!scores.length) return;
    this.bestHistory.push(Math.max(...scores.map((s) => s.scalar)));

    const pinned = new Set(
      [...this.graph.nodes.values()].filter((n) => n.pinned).map((n) => n.branchId),
    );
    const doomed = pruneCandidates(scores, pinned);
    if (doomed.length) {
      const ops: Op[] = [...this.graph.nodes.values()]
        .filter((n) => doomed.includes(n.branchId) && !n.parentId)
        .map((n) => ({ op: "removeNode", id: n.id }));
      if (ops.length) {
        await this.commit({
          id: newId("b"),
          agentId: "pruner",
          role: "scorer",
          origin: "system",
          baseVersions: {},
          ops,
          reasoning: `pruned branches below median − 1.5σ: ${doomed.join(", ")}`,
          ts: Date.now(),
        });
        this.emit({ type: "pruned", branchIds: doomed });
      }
    }
  }
}
