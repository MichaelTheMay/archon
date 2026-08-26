import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BranchScore,
  BudgetSnapshot,
  HaltReason,
  LayoutSnapshot,
  Node,
  RunStatus,
  SerializedGraph,
  TimelineEntry,
} from "@archon/core";
import { Canvas } from "./canvas/Canvas.js";
import { Controls } from "./panels/Controls.js";
import { Frontier } from "./panels/Frontier.js";
import { Scores } from "./panels/Scores.js";
import { Timeline } from "./panels/Timeline.js";
import * as api from "./api.js";

const EMPTY_BUDGET: BudgetSnapshot = { spentUsd: 0, limitUsd: null, calls: 0, inputTokens: 0, outputTokens: 0 };

/** ?run=<id> deep-links to a run — live if it is still going, replayable if it is done. */
const runFromUrl = () => new URLSearchParams(window.location.search).get("run");

export function App() {
  const [runId, setRunIdRaw] = useState<string | null>(runFromUrl);
  const setRunId = useCallback((id: string | null) => {
    setRunIdRaw(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("run", id);
    else url.searchParams.delete("run");
    window.history.replaceState(null, "", url);
  }, []);
  const [past, setPast] = useState<{ id: string; idea: string; status: string }[]>([]);
  const [idea, setIdea] = useState("");
  const [notes, setNotes] = useState("");
  const [graph, setGraph] = useState<SerializedGraph | null>(null);
  const [layout, setLayout] = useState<LayoutSnapshot | null>(null);
  const [scores, setScores] = useState<BranchScore[]>([]);
  const [frontier, setFrontier] = useState<Node[]>([]);
  const [inFlight, setInFlight] = useState<string[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [haltReason, setHaltReason] = useState<HaltReason | undefined>();
  const [budget, setBudget] = useState<BudgetSnapshot>(EMPTY_BUDGET);
  const [timelineEntries, setTimelineEntries] = useState<TimelineEntry[]>([]);
  const [scrub, setScrub] = useState<number | null>(null);
  const [activity, setActivity] = useState<{ agentId: string; role: string; message: string | undefined }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const scrubRef = useRef<number | null>(null);
  scrubRef.current = scrub;

  useEffect(() => {
    if (runId) return;
    void api.listRuns().then((r) => setPast(r.runs.slice(0, 8)));
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    return api.subscribe(runId, (e) => {
      switch (e.type) {
        case "snapshot":
          setGraph(e.graph);
          setLayout(e.layout);
          setScores(e.scores);
          setStatus(e.status);
          setHaltReason(e.haltReason);
          setBudget(e.budget);
          setTimelineEntries(e.timeline);
          break;
        case "batch":
          setTimelineEntries((prev) => [...prev, e.entry]);
          if (scrubRef.current === null) setGraph(e.graph);
          break;
        case "layout":
          if (scrubRef.current === null) setLayout(e.layout);
          break;
        case "frontier":
          setFrontier(e.decisions);
          setInFlight(e.inFlight);
          break;
        case "score":
          setScores((prev) => [...prev.filter((s) => s.branchId !== e.score.branchId), e.score]);
          break;
        case "status":
          setStatus(e.status);
          setHaltReason(e.haltReason);
          setBudget(e.budget);
          break;
        case "agent":
          setActivity((prev) => {
            const next = prev.filter((a) => a.agentId !== e.agentId || a.role !== e.role);
            if (e.state === "start") next.push({ agentId: e.agentId, role: e.role, message: e.message });
            return next.slice(-6);
          });
          break;
        case "rejected":
          setError(`batch rejected: ${e.reason}`);
          break;
        case "error":
          setError(e.message);
          break;
      }
    });
  }, [runId]);

  // Scrubbing loads a past graph state; releasing to live re-syncs from the stream.
  useEffect(() => {
    if (!runId || scrub === null) return;
    let cancelled = false;
    api
      .graphAt(runId, scrub)
      .then((r) => {
        if (cancelled) return;
        setGraph(r.graph);
        setLayout(r.layout);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [runId, scrub]);

  const onStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idea.trim()) return;
    try {
      const r = await api.createRun(idea.trim(), notes.trim() || undefined);
      setRunId(r.id);
    } catch (err) {
      setError(String((err as Error).message));
    }
  };

  const onPin = useCallback(
    (nodeId: string, pos: { x: number; y: number }) => {
      if (!runId) return;
      void api.sendOps(runId, [{ op: "updateNode", id: nodeId, patch: { pinned: true, pinnedPosition: pos } }], "human pinned position");
    },
    [runId],
  );

  if (!runId) {
    return (
      <div className="intake">
        <form onSubmit={onStart}>
          <h1>Archon</h1>
          <p>Give it an idea. It expands the open design decisions breadth-first, researches what it doesn't know, and draws the architecture as it goes.</p>
          <textarea value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="A real-time collaborative document editor for 100k concurrent users…" rows={4} autoFocus />
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Constraints: team size, budget, latency targets, existing stack… (optional)" rows={3} />
          <button type="submit" disabled={!idea.trim()}>Start design run →</button>
          {error && <p className="error">{error}</p>}
          {past.length > 0 && (
            <div className="past">
              <h2>Past runs</h2>
              <ul>
                {past.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => setRunId(r.id)}>
                      <span className={`status ${r.status}`}>{r.status}</span>
                      <span className="idea">{r.idea}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="canvas-wrap">
        <Canvas graph={graph} layout={layout} onPin={onPin} />
      </div>
      <aside className="rail">
        <Controls
          status={status}
          haltReason={haltReason}
          budget={budget}
          activity={activity}
          onControl={(a) => void api.control(runId, a)}
          onBudget={(usd) => void api.setBudget(runId, usd)}
        />
        <Frontier
          decisions={frontier}
          inFlight={inFlight}
          onPin={(id, pinned) => void api.sendOps(runId, [{ op: "updateNode", id, patch: { pinned } }])}
          onKill={(id) => void api.sendOps(runId, [{ op: "removeNode", id }], "human killed branch")}
          onInject={(question) => void api.sendOps(runId, [{ op: "openDecision", question, parentId: "root" }], "human injected decision")}
        />
        <Scores scores={scores} />
        <Timeline entries={timelineEntries} scrub={scrub} onScrub={setScrub} />
        {error && (
          <p className="error" onClick={() => setError(null)}>
            {error}
          </p>
        )}
      </aside>
    </div>
  );
}
