// The Agents graph's left-to-right layout, the direction setting and the
// readable-zoom viewport (2026-10-15). The right pane is usually taller than
// it is wide, so a top-down tree of nine agents came out about 2000 px wide
// and fitView shrank it to dots; left to right stacks the agents down the pane.

import { useCallback, useEffect, useState } from "react";
import { layoutTree, NODE_WIDTH, type TreeNode } from "./subagentGraphLayout";

export type GraphDirection = "tb" | "lr";
/** The stored setting: `auto` picks left to right whenever the pane is taller than wide. */
export type GraphDirectionSetting = "auto" | GraphDirection;

const DIRECTION_STORAGE_KEY = "ae.agentsGraph.direction";
const SETTINGS: readonly GraphDirectionSetting[] = ["auto", "tb", "lr"];

export function readDirectionSetting(): GraphDirectionSetting {
  try {
    const stored = window.localStorage.getItem(DIRECTION_STORAGE_KEY);
    return SETTINGS.includes(stored as GraphDirectionSetting)
      ? (stored as GraphDirectionSetting)
      : "auto";
  } catch {
    return "auto";
  }
}

/** The setting the direction button moves to next: auto, top-down, left-right, auto. */
export function nextDirectionSetting(current: GraphDirectionSetting): GraphDirectionSetting {
  return SETTINGS[(SETTINGS.indexOf(current) + 1) % SETTINGS.length];
}

export function resolveDirection(
  setting: GraphDirectionSetting,
  paneWidth: number,
  paneHeight: number,
): GraphDirection {
  if (setting !== "auto") return setting;
  return paneHeight > paneWidth ? "lr" : "tb";
}

/** The per-device direction setting, remembered in localStorage. */
export function useGraphDirectionSetting(): [GraphDirectionSetting, () => void] {
  const [setting, setSetting] = useState<GraphDirectionSetting>(readDirectionSetting);
  const cycle = useCallback(() => {
    setSetting((current) => {
      const next = nextDirectionSetting(current);
      try {
        window.localStorage.setItem(DIRECTION_STORAGE_KEY, next);
      } catch {
        // Private mode or blocked storage: the choice lasts for this view only.
      }
      return next;
    });
  }, []);
  return [setting, cycle];
}

/** The pane's size in CSS pixels, kept current by a ResizeObserver. */
export function useElementSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

// Left to right, siblings stack down the pane, so the gap between them is
// small; the gap between levels leaves room for the edge curves.
export const LR_NODE_HEIGHT = 64;
const LR_SIBLING_GAP = 14;
const LR_LEVEL_GAP = 56;

type Layout = ReturnType<typeof layoutTree>;

function subtreeHeights(node: TreeNode, heights: Map<string, number>): number {
  const total =
    node.children.length === 0
      ? LR_NODE_HEIGHT
      : node.children.reduce((sum, c) => sum + subtreeHeights(c, heights), 0) +
        (node.children.length - 1) * LR_SIBLING_GAP;
  const height = Math.max(LR_NODE_HEIGHT, total);
  heights.set(node.id, height);
  return height;
}

/**
 * Lay the tree out left to right: each level is a column, each parent
 * centered beside its children. Same nodes and edges as upstream's
 * top-down `layoutTree`, so the graph view renders either one.
 */
export function layoutTreeLeftRight(root: TreeNode, activeId: string): Layout {
  const heights = new Map<string, number>();
  subtreeHeights(root, heights);
  // Reuse upstream's node data and edge styles, then move every node.
  const base = layoutTree(root, activeId);
  const positions = new Map<string, { x: number; y: number }>();

  function place(node: TreeNode, x: number, centerY: number) {
    positions.set(node.id, { x, y: centerY - LR_NODE_HEIGHT / 2 });
    let top = centerY - (heights.get(node.id) ?? LR_NODE_HEIGHT) / 2;
    for (const child of node.children) {
      const height = heights.get(child.id) ?? LR_NODE_HEIGHT;
      place(child, x + NODE_WIDTH + LR_LEVEL_GAP, top + height / 2);
      top += height + LR_SIBLING_GAP;
    }
  }
  place(root, 0, 0);

  return {
    nodes: base.nodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    })),
    edges: base.edges,
  };
}

/** Below this zoom node labels stop being readable, so the pane pans instead. */
export const MIN_READABLE_ZOOM = 0.7;
const MAX_FIT_ZOOM = 1;
const FIT_PADDING_PX = 24;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Fit the graph in the pane, but never below `MIN_READABLE_ZOOM` and never
 * above 100%. When the graph does not fit at a readable size, keep the root
 * in view (top-left for left to right, top-center for top-down) and let the
 * user scroll or drag to the rest.
 *
 * @param bounds - The graph's bounding box in flow coordinates.
 * @param root - The root node's position and size in flow coordinates.
 */
export function readableViewport(
  bounds: { x: number; y: number; width: number; height: number },
  root: { x: number; y: number; width: number; height: number },
  pane: { width: number; height: number },
  direction: GraphDirection,
): Viewport {
  const availableWidth = Math.max(1, pane.width - 2 * FIT_PADDING_PX);
  const availableHeight = Math.max(1, pane.height - 2 * FIT_PADDING_PX);
  const fit = Math.min(
    availableWidth / Math.max(1, bounds.width),
    availableHeight / Math.max(1, bounds.height),
  );
  const zoom = Math.min(MAX_FIT_ZOOM, Math.max(MIN_READABLE_ZOOM, fit));
  const centered = (start: number, length: number, paneLength: number) =>
    (paneLength - length * zoom) / 2 - start * zoom;

  const fitsWidth = bounds.width * zoom <= availableWidth;
  const fitsHeight = bounds.height * zoom <= availableHeight;
  let x = centered(bounds.x, bounds.width, pane.width);
  let y = centered(bounds.y, bounds.height, pane.height);
  if (!fitsWidth) {
    x =
      direction === "lr"
        ? FIT_PADDING_PX - bounds.x * zoom
        : pane.width / 2 - (root.x + root.width / 2) * zoom;
  }
  // A top-down tree too wide to read whole starts at the top of the pane.
  if (!fitsHeight || (direction === "tb" && !fitsWidth)) {
    y =
      direction === "lr"
        ? Math.min(
            FIT_PADDING_PX - bounds.y * zoom,
            pane.height / 2 - (root.y + root.height / 2) * zoom,
          )
        : FIT_PADDING_PX - bounds.y * zoom;
  }
  return { x, y, zoom };
}
