import { afterEach, describe, expect, it } from "vitest";
import {
  layoutTreeLeftRight,
  LR_NODE_HEIGHT,
  MIN_READABLE_ZOOM,
  nextDirectionSetting,
  readableViewport,
  readDirectionSetting,
  resolveDirection,
} from "./aeAgentsGraphLayout";
import { layoutTree, NODE_WIDTH, type TreeNode } from "./subagentGraphLayout";

function leaf(id: string): TreeNode {
  return { id, label: id, activity: "done", statusLabel: "Done", preview: null, children: [] };
}

const nine = Array.from({ length: 9 }, (_, i) => leaf(`c${i}`));
const root: TreeNode = { ...leaf("root"), activity: "working", children: nine };

describe("direction setting", () => {
  afterEach(() => window.localStorage.clear());

  it("goes left to right in a pane taller than wide, top-down otherwise", () => {
    expect(resolveDirection("auto", 620, 1100)).toBe("lr");
    expect(resolveDirection("auto", 1100, 620)).toBe("tb");
    expect(resolveDirection("tb", 620, 1100)).toBe("tb");
    expect(resolveDirection("lr", 1100, 620)).toBe("lr");
  });

  it("cycles auto, top-down, left to right and reads back what was stored", () => {
    expect(nextDirectionSetting("auto")).toBe("tb");
    expect(nextDirectionSetting("tb")).toBe("lr");
    expect(nextDirectionSetting("lr")).toBe("auto");
    expect(readDirectionSetting()).toBe("auto");
    window.localStorage.setItem("ae.agentsGraph.direction", "lr");
    expect(readDirectionSetting()).toBe("lr");
    window.localStorage.setItem("ae.agentsGraph.direction", "sideways");
    expect(readDirectionSetting()).toBe("auto");
  });
});

describe("layoutTreeLeftRight", () => {
  it("puts the children in one column right of the root, stacked down the pane", () => {
    const { nodes, edges } = layoutTreeLeftRight(root, "root");
    const rootNode = nodes.find((n) => n.id === "root")!;
    const kids = nodes.filter((n) => n.id !== "root");
    expect(new Set(kids.map((n) => n.position.x))).toEqual(
      new Set([rootNode.position.x + NODE_WIDTH + 56]),
    );
    const ys = kids.map((n) => n.position.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(LR_NODE_HEIGHT);
    // The root sits level with the middle of its children.
    expect(rootNode.position.y).toBeCloseTo((ys[0] + ys[ys.length - 1]) / 2);
    expect(edges).toHaveLength(9);
  });

  it("keeps the node data and edges of the top-down layout", () => {
    const lr = layoutTreeLeftRight(root, "c3");
    const tb = layoutTree(root, "c3");
    expect(lr.nodes.map((n) => n.data)).toEqual(tb.nodes.map((n) => n.data));
    expect(lr.edges).toEqual(tb.edges);
  });

  it("is narrow enough for a 620 px pane where top-down is about 2000 px wide", () => {
    const width = (nodes: { position: { x: number } }[]) =>
      Math.max(...nodes.map((n) => n.position.x)) +
      NODE_WIDTH -
      Math.min(...nodes.map((n) => n.position.x));
    expect(width(layoutTree(root, "root").nodes)).toBeGreaterThan(1900);
    expect(width(layoutTreeLeftRight(root, "root").nodes)).toBeLessThan(620);
  });
});

describe("readableViewport", () => {
  const pane = { width: 620, height: 1100 };

  it("fits a small graph without zooming past 100%", () => {
    const bounds = { x: 0, y: 0, width: 200, height: 60 };
    const view = readableViewport(bounds, bounds, pane, "lr");
    expect(view.zoom).toBe(1);
    expect(view.x).toBeCloseTo((620 - 200) / 2);
  });

  it("stops at the readable zoom and keeps the root in view instead of shrinking to dots", () => {
    const bounds = { x: -1000, y: 0, width: 2000, height: 150 };
    const rootBox = { x: -90, y: 0, width: 180, height: 60 };
    const view = readableViewport(bounds, rootBox, pane, "tb");
    expect(view.zoom).toBe(MIN_READABLE_ZOOM);
    // Root centered horizontally, graph top at the padding.
    expect(view.x + 0 * view.zoom).toBeCloseTo(310);
    expect(view.y).toBeCloseTo(24);
  });

  it("anchors a too-tall left-to-right graph on the root", () => {
    const bounds = { x: 0, y: -1500, width: 420, height: 3000 };
    const rootBox = { x: 0, y: -30, width: 180, height: 60 };
    const view = readableViewport(bounds, rootBox, pane, "lr");
    expect(view.zoom).toBe(MIN_READABLE_ZOOM);
    expect(view.y).toBeCloseTo(550);
  });
});
