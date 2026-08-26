import { useCallback, useEffect, useRef } from "react";
import { Tldraw, type Editor, type TLComponents } from "tldraw";
import "tldraw/tldraw.css";
import type { LayoutSnapshot, SerializedGraph } from "@archon/core";
import { applyProjection, shapeIdFor } from "./project.js";

interface Props {
  graph: SerializedGraph | null;
  layout: LayoutSnapshot | null;
  onPin?: (nodeId: string, pos: { x: number; y: number }) => void;
}

export function Canvas({ graph, layout, onPin }: Props) {
  const editorRef = useRef<Editor | null>(null);
  const fitted = useRef(false);

  const onMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;
      // A human dragging a node pins it: the layout engine then treats that position
      // as fixed rather than fighting the user on the next pass.
      editor.store.listen(
        (entry) => {
          if (!onPin) return;
          for (const record of Object.values(entry.changes.updated)) {
            const shape = Array.isArray(record) ? record[1] : record;
            if (!shape || typeof shape !== "object" || !("id" in shape)) continue;
            const s = shape as { id: string; x?: number; y?: number };
            if (!s.id.startsWith("shape:n-")) continue;
            const nodeId = s.id.replace("shape:n-", "");
            if (typeof s.x === "number" && typeof s.y === "number") onPin(nodeId, { x: s.x, y: s.y });
          }
        },
        { source: "user", scope: "document" },
      );
    },
    [onPin],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !graph || !layout) return;
    applyProjection(editor, graph, layout);
    if (!fitted.current && graph.nodes.length > 0) {
      fitted.current = true;
      const ids = graph.nodes.map((n) => shapeIdFor(n.id)).filter((id) => editor.getShape(id));
      if (ids.length) editor.zoomToFit({ animation: { duration: 200 } });
    }
  }, [graph, layout]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Tldraw onMount={onMount} components={COMPONENTS} />
    </div>
  );
}

// The canvas is a projection of the graph, not a drawing surface: the drawing tools and
// style panel would only let a user make edits the next layout pass would discard.
// Navigation (pan/zoom/minimap) stays.
const COMPONENTS: TLComponents = {
  Toolbar: null,
  StylePanel: null,
  MainMenu: null,
  PageMenu: null,
  ActionsMenu: null,
  QuickActions: null,
  HelpMenu: null,
  DebugPanel: null,
  DebugMenu: null,
};
