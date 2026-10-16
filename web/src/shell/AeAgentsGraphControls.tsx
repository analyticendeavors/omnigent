// Graph-side pieces of the Agents pane redesign (2026-10-15): the readable
// fit that replaces React Flow's fitView, and the direction button.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import {
  AE_ICON_LAYOUT_AUTO,
  AE_ICON_LAYOUT_LEFT_RIGHT,
  AE_ICON_LAYOUT_TOP_DOWN,
} from "@/lib/aeAgentsIcons";
import {
  readableViewport,
  type GraphDirection,
  type GraphDirectionSetting,
} from "./aeAgentsGraphLayout";

/**
 * A fit that stops at a readable zoom and keeps the root in view. Refits
 * only when the node set, direction or pane size changes, so a poll that
 * updates a node's text leaves the user's pan and zoom alone.
 *
 * @param rootId - The root node's id, the anchor when the graph overflows.
 * @returns The fit, for the Fit view button.
 */
export function useReadableFit(
  rootId: string,
  direction: GraphDirection,
  pane: { width: number; height: number },
): () => void {
  const { setViewport, getNodes, getNodesBounds } = useReactFlow();
  const storeNodes = useStore((s) => s.nodes);
  const nodeIds = useMemo(() => storeNodes.map((n) => n.id).join("|"), [storeNodes]);
  const measured = useStore((s) => {
    if (s.nodeLookup.size === 0) return false;
    for (const node of s.nodeLookup.values()) {
      if (!node.measured.width || !node.measured.height) return false;
    }
    return true;
  });
  const fit = useCallback(
    (duration = 0) => {
      const nodes = getNodes();
      if (nodes.length === 0 || pane.width === 0 || pane.height === 0) return;
      const root = nodes.find((n) => n.id === rootId) ?? nodes[0];
      const rootBox = getNodesBounds([root]);
      const viewport = readableViewport(getNodesBounds(nodes), rootBox, pane, direction);
      void setViewport(viewport, { duration });
    },
    [getNodes, getNodesBounds, setViewport, rootId, direction, pane],
  );
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const fittedFor = useRef("");
  useEffect(() => {
    const shape = `${nodeIds}#${direction}#${pane.width}x${pane.height}`;
    if (!measured || fittedFor.current === shape) return;
    fittedFor.current = shape;
    fitRef.current();
  }, [measured, nodeIds, direction, pane.width, pane.height]);
  return useCallback(() => fit(200), [fit]);
}

const DIRECTION_LABEL: Record<GraphDirectionSetting, string> = {
  auto: "Layout: automatic (left to right in a tall pane)",
  tb: "Layout: top-down",
  lr: "Layout: left to right",
};

const DIRECTION_ICON = {
  auto: AE_ICON_LAYOUT_AUTO,
  tb: AE_ICON_LAYOUT_TOP_DOWN,
  lr: AE_ICON_LAYOUT_LEFT_RIGHT,
};

/** Cycles the graph's direction: automatic, top-down, left to right. */
export function AeGraphDirectionButton({
  setting,
  onCycle,
  className,
}: {
  setting: GraphDirectionSetting;
  onCycle: () => void;
  className: string;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={onCycle}
      aria-label={`${DIRECTION_LABEL[setting]}. Change layout`}
      title={DIRECTION_LABEL[setting]}
      data-testid="agents-graph-direction"
      data-direction-setting={setting}
    >
      <AeTablerSvg node={DIRECTION_ICON[setting]} className="size-4" />
    </button>
  );
}
