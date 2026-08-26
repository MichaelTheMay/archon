import { SCORE_DIMS, type BranchScore } from "@archon/core";

export function Scores({ scores }: { scores: BranchScore[] }) {
  if (!scores.length) return null;
  const ranked = [...scores].sort((a, b) => b.scalar - a.scalar);
  return (
    <section className="panel">
      <h2>Branches</h2>
      <table className="scores">
        <thead>
          <tr>
            <th>branch</th>
            <th>score</th>
            {SCORE_DIMS.map((d) => (
              <th key={d} title={d}>
                {d.slice(0, 3)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ranked.map((s, i) => (
            <tr key={s.branchId} className={i === 0 ? "best" : undefined}>
              <td>{s.branchId}</td>
              <td className="scalar">{s.scalar.toFixed(1)}</td>
              {SCORE_DIMS.map((d) => (
                <td key={d} title={s.justification[d]}>
                  {s.vector[d]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
