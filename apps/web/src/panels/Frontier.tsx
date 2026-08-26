import { useState } from "react";
import type { Node } from "@archon/core";

interface Props {
  decisions: Node[];
  inFlight: string[];
  onPin: (id: string, pinned: boolean) => void;
  onKill: (id: string) => void;
  onInject: (question: string) => void;
}

/** The loop's mind, made inspectable and editable while it runs. */
export function Frontier({ decisions, inFlight, onPin, onKill, onInject }: Props) {
  const [draft, setDraft] = useState("");
  const busy = new Set(inFlight);

  return (
    <section className="panel">
      <h2>
        Frontier <span className="count">{decisions.length}</span>
      </h2>
      <ul className="frontier">
        {decisions.map((d) => (
          <li key={d.id} className={busy.has(d.id) ? "row busy" : "row"}>
            <div className="row-main">
              <span className="depth">d{d.depth}</span>
              <span className="label">{d.label}</span>
            </div>
            <div className="row-actions">
              {busy.has(d.id) && <span className="spinner" title="expanding" />}
              <button onClick={() => onPin(d.id, !d.pinned)} title="pin (protect from pruning)">
                {d.pinned ? "📌" : "📍"}
              </button>
              <button onClick={() => onKill(d.id)} title="kill this branch">
                ✕
              </button>
            </div>
          </li>
        ))}
        {!decisions.length && <li className="empty">frontier empty</li>}
      </ul>
      <form
        className="inject"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          onInject(draft.trim());
          setDraft("");
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Inject a decision…" />
        <button type="submit">+</button>
      </form>
    </section>
  );
}
