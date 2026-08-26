import { useState } from "react";
import type { Node } from "@archon/core";

interface Props {
  node: Node | null;
  onPin: (id: string, pinned: boolean) => void;
  onKill: (id: string) => void;
  onSteer: (id: string, text: string) => void;
  onAsk: (parentId: string, question: string) => void;
  onClose: () => void;
}

/** Click a shape on the canvas; act on it here. */
export function Inspector({ node, onPin, onKill, onSteer, onAsk, onClose }: Props) {
  const [draft, setDraft] = useState("");
  if (!node) return null;
  const d = node.data;

  return (
    <section className="panel inspector">
      <h2>
        {node.kind} <span className="count">d{node.depth}</span>
        <button className="close" onClick={onClose} title="deselect">
          ✕
        </button>
      </h2>
      <p className="node-label">{node.label}</p>

      {d.kind === "decision" && (
        <>
          <p className="meta">
            status <b>{d.status}</b>
            {d.attempts > 0 && ` · ${d.attempts} failed attempts`}
          </p>
          {d.chosen && (
            <p className="chosen">
              <b>{d.chosen}</b>
              {d.rationale && <span className="rationale"> — {d.rationale}</span>}
            </p>
          )}
          {!!d.options.length && !d.chosen && (
            <ul className="options">
              {d.options.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          )}
        </>
      )}

      {d.kind === "component" && (
        <>
          <p className="meta">
            {d.componentType}
            {d.technology && ` · ${d.technology}`}
          </p>
          {!!d.responsibilities.length && (
            <ul className="options">
              {d.responsibilities.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </>
      )}

      {d.kind === "research" && (
        <>
          <p className="meta">{d.query}</p>
          {d.recommendation && <p className="chosen">{d.recommendation}</p>}
          <ul className="options">
            {d.findings.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          {!!d.sources.length && (
            <ul className="sources">
              {d.sources.map((s) => (
                <li key={s.title}>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.title}
                    </a>
                  ) : (
                    s.title
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {(d.kind === "requirement" || d.kind === "assumption") && node.description && (
        <p className="meta">{node.description}</p>
      )}

      <div className="controls">
        <button onClick={() => onPin(node.id, !node.pinned)}>{node.pinned ? "📌 unpin" : "📍 pin"}</button>
        <button onClick={() => onKill(node.id)}>✕ kill subtree</button>
      </div>

      <form
        className="inject"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text) return;
          // On an assumption or requirement, correcting the text re-frames the run.
          // On anything else, the text becomes a new decision hanging off this node.
          if (d.kind === "assumption" || d.kind === "requirement") onSteer(node.id, text);
          else onAsk(node.id, text);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={d.kind === "assumption" || d.kind === "requirement" ? "Correct this…" : "Ask a follow-up decision…"}
        />
        <button type="submit">→</button>
      </form>
    </section>
  );
}
