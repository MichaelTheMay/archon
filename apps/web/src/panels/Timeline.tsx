import type { TimelineEntry } from "@archon/core";

interface Props {
  entries: TimelineEntry[];
  /** null = live; a number = viewing the graph as of that sequence number */
  scrub: number | null;
  onScrub: (seq: number | null) => void;
}

/**
 * The expansion is recorded, not just streamed: every batch is a frame, so you can
 * scrub back and watch the diagram build itself after the fact.
 */
export function Timeline({ entries, scrub, onScrub }: Props) {
  if (entries.length < 2) return null;
  const first = entries[0]!.seq;
  const last = entries[entries.length - 1]!.seq;
  const current = scrub ?? last;
  const at = entries.find((e) => e.seq === current) ?? entries[entries.length - 1]!;
  const elapsed = ((at.ts - entries[0]!.ts) / 1000).toFixed(0);

  return (
    <section className="panel timeline">
      <h2>
        Replay {scrub === null ? <span className="live">live</span> : <span className="past">t+{elapsed}s</span>}
      </h2>
      <input
        type="range"
        min={first}
        max={last}
        value={current}
        onChange={(e) => {
          const v = Number(e.target.value);
          onScrub(v >= last ? null : v);
        }}
      />
      <div className="frame">
        <span className={`role ${at.role}`}>{at.role}</span>
        <span className="seq">
          {at.seq - first + 1}/{last - first + 1}
        </span>
        <span className="ops">{at.opCount} ops</span>
        {scrub !== null && (
          <button className="tolive" onClick={() => onScrub(null)}>
            ⏭ live
          </button>
        )}
      </div>
      {at.reasoning && <p className="reasoning">{at.reasoning}</p>}
    </section>
  );
}
