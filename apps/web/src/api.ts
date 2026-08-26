import type { LayoutSnapshot, Op, RunEvent, SerializedGraph } from "@archon/core";

const json = { "content-type": "application/json" };

export async function createRun(idea: string, notes?: string): Promise<{ id: string }> {
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ idea, notes, autostart: true }),
  });
  if (!res.ok) throw new Error(`createRun failed: ${res.status}`);
  return res.json();
}

export async function listRuns(): Promise<{ runs: { id: string; idea: string; status: string; createdAt: number }[] }> {
  return (await fetch("/api/runs")).json();
}

export async function control(runId: string, action: "start" | "pause" | "resume" | "step"): Promise<void> {
  await fetch(`/api/runs/${runId}/${action}`, { method: "POST" });
}

export async function sendOps(runId: string, ops: Op[], reasoning?: string): Promise<void> {
  await fetch(`/api/runs/${runId}/ops`, { method: "POST", headers: json, body: JSON.stringify({ ops, reasoning }) });
}

export async function setBudget(runId: string, usd: number | null): Promise<void> {
  await fetch(`/api/runs/${runId}/budget`, { method: "POST", headers: json, body: JSON.stringify({ usd }) });
}

export async function graphAt(runId: string, seq: number): Promise<{ graph: SerializedGraph; layout: LayoutSnapshot }> {
  const res = await fetch(`/api/runs/${runId}/at/${seq}`);
  if (!res.ok) throw new Error(`graphAt failed: ${res.status}`);
  return res.json();
}

const EVENT_TYPES: RunEvent["type"][] = [
  "snapshot",
  "batch",
  "rejected",
  "layout",
  "score",
  "pruned",
  "frontier",
  "status",
  "agent",
  "error",
];

export function subscribe(runId: string, onEvent: (e: RunEvent) => void): () => void {
  const es = new EventSource(`/api/runs/${runId}/events`);
  for (const t of EVENT_TYPES) {
    es.addEventListener(t, (ev) => {
      try {
        onEvent(JSON.parse((ev as MessageEvent).data) as RunEvent);
      } catch {
        /* ignore malformed frame */
      }
    });
  }
  return () => es.close();
}
