import type { Editor, TLDefaultColorStyle, TLGeoShapeProps, TLShapeId } from "tldraw";
import { createShapeId, toRichText } from "tldraw";
import { displayLabel, type LayoutSnapshot, type Node, type SerializedGraph } from "@archon/core";

/**
 * Project the DesignGraph onto tldraw. The graph is the source of truth; this is a view.
 * Shape ids derive from node ids, so re-projecting a changed graph animates a diff
 * instead of redrawing the canvas.
 */

type Geo = TLGeoShapeProps["geo"];

const COLORS: Record<string, TLDefaultColorStyle> = {
  service: "blue",
  datastore: "violet",
  queue: "orange",
  cache: "yellow",
  gateway: "green",
  client: "light-blue",
  external: "grey",
};

function styleFor(n: Node): { geo: Geo; color: TLDefaultColorStyle } {
  switch (n.kind) {
    case "decision":
      return { geo: "diamond", color: n.data.kind === "decision" && n.data.status === "open" ? "red" : "light-green" };
    case "requirement":
      return { geo: "rectangle", color: "black" };
    case "assumption":
      return { geo: "ellipse", color: "grey" };
    case "research":
      return { geo: "cloud", color: "light-violet" };
    default:
      return {
        geo: "rectangle",
        color: n.data.kind === "component" ? (COLORS[n.data.componentType] ?? "blue") : "blue",
      };
  }
}

export const shapeIdFor = (nodeId: string): TLShapeId => createShapeId(`n-${nodeId}`);
const arrowIdFor = (edgeId: string): TLShapeId => createShapeId(`e-${edgeId}`);

export function applyProjection(editor: Editor, graph: SerializedGraph, layout: LayoutSnapshot): void {
  editor.store.mergeRemoteChanges(() => {
    const wanted = new Set<string>();

    for (const n of graph.nodes) {
      const box = layout.nodes[n.id];
      if (!box) continue;
      const id = shapeIdFor(n.id);
      wanted.add(id);
      const { geo, color } = styleFor(n);
      if (editor.getShape(id)) {
        editor.updateShape({
          id,
          type: "geo",
          x: box.x,
          y: box.y,
          props: { geo, color, w: box.w, h: box.h, richText: toRichText(displayLabel(n)) },
        });
      } else {
        editor.createShape({
          id,
          type: "geo",
          x: box.x,
          y: box.y,
          props: { geo, color, w: box.w, h: box.h, size: "s", font: "sans", richText: toRichText(displayLabel(n)) },
        });
      }
    }

    // Arrows are positioned from the laid-out boxes; tldraw bindings are deliberately not
    // used, so a re-layout never fights the projection.
    for (const e of graph.edges) {
      // `satisfies` fans from every component to a handful of shared requirements: drawing
      // it is an O(n·m) hairball that buries the actual architecture. The coverage it
      // encodes is surfaced in the Branches score table instead.
      if (e.type === "child_of" || e.type === "satisfies") continue;
      const a = layout.nodes[e.from];
      const b = layout.nodes[e.to];
      if (!a || !b) continue;
      const id = arrowIdFor(e.id);
      wanted.add(id);
      const start = { x: a.x + a.w / 2, y: a.y + a.h };
      const end = { x: b.x + b.w / 2, y: b.y };
      const color: TLDefaultColorStyle = e.type === "informs" ? "violet" : "black";
      const shape = {
        id,
        type: "arrow" as const,
        x: start.x,
        y: start.y,
        props: {
          start: { x: 0, y: 0 },
          end: { x: end.x - start.x, y: end.y - start.y },
          color,
          dash: (e.type === "flows" ? "draw" : "dashed") as TLGeoShapeProps["dash"],
          size: "s" as const,
          richText: toRichText(e.label ?? ""),
        },
      };
      if (editor.getShape(id)) editor.updateShape(shape);
      else editor.createShape(shape);
    }

    const stale = [...editor.getCurrentPageShapeIds()].filter((id) => !wanted.has(id));
    if (stale.length) editor.deleteShapes(stale);
  });
}
