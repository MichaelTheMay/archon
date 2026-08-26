import type { BudgetSnapshot, HaltReason, RunStatus } from "@archon/core";

interface Props {
  status: RunStatus;
  haltReason: HaltReason | undefined;
  budget: BudgetSnapshot;
  activity: { agentId: string; role: string; message: string | undefined }[];
  workers: number;
  onControl: (a: "start" | "pause" | "step") => void;
  onBudget: (usd: number | null) => void;
}

export function Controls({ status, haltReason, budget, activity, workers, onControl, onBudget }: Props) {
  const pct = budget.limitUsd ? Math.min(100, (budget.spentUsd / budget.limitUsd) * 100) : 0;
  return (
    <section className="panel">
      <h2>
        Run <span className={`status ${status}`}>{status}</span>
        {haltReason && <span className="halt">{haltReason.replace("_", " ")}</span>}
      </h2>
      <div className="controls">
        <button className="primary" onClick={() => onControl(status === "running" ? "pause" : "start")}>
          {status === "running" ? "⏸ stop" : "▶ grow"}
        </button>
        <button onClick={() => onControl("step")}>⏭ step</button>
      </div>
      {haltReason === "budget" && status === "paused" && (
        <p className="throttled">Hit the budget. Raise it below and press grow to carry on.</p>
      )}
      {haltReason === "node_limit" && status === "paused" && (
        <p className="throttled">Hit the node cap. Raise MAX_NODES to keep growing.</p>
      )}
      <div className="budget">
        <div className="bar">
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>
        <label>
          ${budget.spentUsd.toFixed(3)} /{" "}
          <input
            type="number"
            step="0.5"
            min="0"
            value={budget.limitUsd ?? 0}
            onChange={(e) => onBudget(Number(e.target.value) || null)}
          />
        </label>
        <span className="tokens">
          {budget.calls} calls · {((budget.inputTokens + budget.outputTokens) / 1000).toFixed(1)}k tok
        </span>
      </div>
      {activity.length > 0 && (
        <ul className="activity">
          <li className="workers">
            {workers} worker{workers === 1 ? "" : "s"} in flight
          </li>
          {activity.map((a) => (
            <li key={a.agentId + a.role}>
              <span className={`role ${a.role}`}>{a.role}</span>
              {a.message && <span className="msg">{a.message}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
