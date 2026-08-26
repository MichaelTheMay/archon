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
  stratify,
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
  type ScoredDecision,
} from "@archon/core";
import {
  Provider,
  compileCriticOps,
  compileForkOps,
  compileIntakeOps,
  compileOps,
  compileResearchOps,
  forkCandidates,
  researchFor,
  runCritic,
  runExpander,
  runIntake,
  runResearcher,
  runScorer,
} from "@archon/agents";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import { debounceLayout, layoutGraph } from "./layout.js";
import type { OpLog } from "./oplog.js";

const SCORE_EVERY = 4;
/** How many commits between scheduled branch forks. */
const GROW_EVERY = 8;

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
  private slotWaiters: (() => void)[] = [];
  private scoring = false;
  private growing = false;
  private commitsSinceGrow = 0;
  private lastRejectWasConflict = false;
  private lastCritique = new Map<string, number>();
  private forked = new Set<string>();
  private forkCounter = 1;
  private scheduleLayout: (g: ReturnType<typeof serializeGraph>) => void;

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
    // ELK over the whole graph on every commit serialises the commit path once several
    // workers are running. Coalesce bursts into one pass instead.
    this.scheduleLayout = debounceLayout((g) => {
      void layoutGraph(g).then((layout) => {
        this.layout = layout;
        this.emit({ type: "layout", layout });
      });
    }, 400);
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
      this.lastRejectWasConflict = /version conflict/.test(res.rejected.reason);
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
    this.scheduleLayout(graph);
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
      // Pause rather than halt: a timed-out call or a bad response should never
      // permanently kill a run whose whole point is to keep going. Pressing grow retries.
      this.status = "paused";
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

  /**
   * A continuous worker pool, not a wave.
   *
   * The old loop dispatched a batch and awaited all of it, so every worker sat idle
   * waiting for the slowest one and expansion advanced in lockstep. Here a slot that
   * frees is refilled immediately from the scheduler, which reserves capacity per depth
   * band so deep and shallow work advance together rather than depth waiting its turn.
   *
   * In continuous mode an empty frontier is not the end: it is the cue to generate more
   * work -- critique the design, open up its black boxes, fork a decision into a rival
   * branch -- so the design keeps getting bigger until a human stops it.
   */
  private async loop(): Promise<void> {
    if (this.graph.nodes.size === 0) {
      await this.intake();
    }

    while (this.status === "running") {
      // Soft caps: pause and surface why, so bumping the dial resumes from right here.
      if (this.budget.exhausted()) return this.softStop("budget");
      if (this.graph.nodes.size >= this.limits.maxNodes) return this.softStop("node_limit");

      const slots = this.concurrency - this.inFlight.size;
      if (slots > 0) {
        const picks = stratify({ graph: this.graph, scores: this.scoreMap() }, slots, this.inFlight);
        if (picks.length) {
          for (const pick of picks) this.spawn(pick);
          if (this.stepOnce) {
            this.stepOnce = false;
            this.pause();
          }
          continue;
        }
      }

      // Nothing dispatchable: either the workers are busy, or the frontier has run dry.
      if (this.inFlight.size > 0) {
        await this.waitForSlot();
        continue;
      }

      if (!this.cfg.CONTINUOUS) return this.halt("frontier_empty");
      if (!(await this.grow())) return this.halt("frontier_empty");
    }
  }

  /** Fire a worker without awaiting it; the pool refills as each one finishes. */
  private spawn(pick: ScoredDecision): void {
    this.inFlight.add(pick.node.id);
    void this.expandOne(pick.node, pick.why).finally(() => {
      this.inFlight.delete(pick.node.id);
      this.releaseSlot();
      void this.maybeScore();
    });
  }

  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.slotWaiters.push(resolve);
      setTimeout(resolve, 2_000); // safety tick: a lost wakeup must not park the loop
    });
  }

  private releaseSlot(): void {
    const waiters = this.slotWaiters;
    this.slotWaiters = [];
    for (const w of waiters) w();
  }

  private scoreMap(): Map<string, BranchScore> {
    return new Map(this.log.scores(this.id).map((s) => [s.branchId, s]));
  }

  private async maybeScore(): Promise<void> {
    this.commitsSinceScore += 1;
    this.commitsSinceGrow += 1;
    this.logger.debug(
      { sinceScore: this.commitsSinceScore, sinceGrow: this.commitsSinceGrow, branches: branchIds(this.graph).length },
      "worker finished",
    );

    // Growth must not wait for an idle frontier. With a full worker pool the frontier
    // never empties, so forking-on-empty would mean the run only ever explores one
    // branch — and the whole ranked-forest apparatus stays dormant. Fork on a cadence.
    if (this.cfg.CONTINUOUS && this.commitsSinceGrow >= GROW_EVERY && !this.growing) {
      this.commitsSinceGrow = 0;
      this.growing = true;
      try {
        await this.fork();
      } catch (err) {
        this.logger.warn({ err }, "scheduled fork failed");
      } finally {
        this.growing = false;
      }
    }

    if (this.commitsSinceScore < SCORE_EVERY || this.scoring) return;
    this.commitsSinceScore = 0;
    this.scoring = true;
    try {
      await this.scoreAndPrune();
    } finally {
      this.scoring = false;
    }
  }

  /**
   * Generate new work when the frontier empties: critique the branch that has gone
   * longest without it, then fork a resolved decision into a rival branch so the Scorer
   * finally has candidates to rank against each other.
   */
  private async grow(): Promise<boolean> {
    if (await this.critique()) return true;
    if (await this.fork()) return true;
    return false;
  }

  private async critique(): Promise<boolean> {
    const branches = branchIds(this.graph).filter((b) => branchSummary(this.graph, b).components.length > 0);
    const target = branches.sort((a, b) => (this.lastCritique.get(a) ?? 0) - (this.lastCritique.get(b) ?? 0))[0];
    if (!target) return false;

    const agentId = newId("ag");
    this.emit({ type: "agent", agentId, role: "critic", state: "start", message: `critiquing ${target}` });
    try {
      const summary = branchSummary(this.graph, target);
      const { output, usage, model } = await runCritic(this.provider, summary, this.lastSeq);
      this.budget.record(model, usage);
      this.lastCritique.set(target, Date.now());

      const ops = compileCriticOps(summary, output, (parentId) => this.childBudgetFor(parentId));
      if (!ops.length) return false;
      return await this.commit({
        id: newId("b"),
        agentId,
        role: "critic",
        origin: "agent",
        baseVersions: {},
        ops,
        reasoning: `${output.holes.length} holes, ${output.decompose.length} components to open up`,
        ts: Date.now(),
      });
    } catch (err) {
      this.logger.warn({ err, branchId: target }, "critic failed");
      return false;
    } finally {
      this.emit({ type: "agent", agentId, role: "critic", state: "end" });
    }
  }

  private async fork(): Promise<boolean> {
    const branches = branchIds(this.graph).length;
    if (branches >= this.cfg.MAX_BRANCHES) return false;
    const candidates = forkCandidates([...this.graph.nodes.values()], this.limits.maxDepth).filter(
      (n) => !this.forked.has(n.id),
    );
    const target = candidates[0];
    this.logger.info({ branches, candidates: candidates.length, target: target?.id }, "fork check");
    if (!target) return false;

    this.forked.add(target.id);
    const branchId = `alt${this.forkCounter++}`;
    const ops = compileForkOps(target, branchId);
    if (!ops.length) return false;

    const chosen = target.data.kind === "decision" ? target.data.chosen : undefined;
    this.emit({ type: "agent", agentId: branchId, role: "orchestrator", state: "start", message: `forking: ${target.label}` });
    const ok = await this.commit({
      id: newId("b"),
      agentId: branchId,
      role: "orchestrator",
      origin: "system",
      baseVersions: {},
      ops,
      reasoning: `forked "${target.label}" into ${branchId} to explore alternatives to "${chosen ?? "?"}"`,
      ts: Date.now(),
    });
    this.emit({ type: "agent", agentId: branchId, role: "orchestrator", state: "end" });
    return ok;
  }

  /** Budget and size are throttles, not terminal conditions: pause so a human can resume. */
  private softStop(reason: HaltReason): void {
    this.status = "paused";
    this.haltReason = reason;
    this.logger.info({ reason, spentUsd: this.budget.spentUsd, nodes: this.graph.nodes.size }, "soft stop");
    this.emitStatus();
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
  private async expandOne(decision: Node, why = ""): Promise<void> {
    const agentId = newId("ag");
    this.emitFrontier();
    this.emit({ type: "agent", agentId, role: "expander", state: "start", decisionId: decision.id, message: why });

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

      // A version conflict is contention, not failure. With a busy pool, several workers
      // legitimately touch overlapping context; counting those toward the three-strike
      // stall would take healthy decisions out purely for raising concurrency.
      if (!ok && !this.lastRejectWasConflict) await this.bumpAttempts(decision);
      this.emit({ type: "agent", agentId, role: "expander", state: "end", decisionId: decision.id });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      this.logger.error({ err, decisionId: decision.id }, "expander failed");
      if (/429|rate.?limit/i.test(msg)) this.throttle();
      await this.bumpAttempts(decision);
      this.emit({ type: "agent", agentId, role: "expander", state: "error", decisionId: decision.id, message: msg });
    } finally {
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
    // Taper slowly: in continuous mode this is local shape control (stop one node
    // exploding), not the thing that ends the run, so it must not choke depth off early.
    const taper = Math.max(1, this.limits.maxChildrenPerDecision - Math.floor(depth / 3));
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
