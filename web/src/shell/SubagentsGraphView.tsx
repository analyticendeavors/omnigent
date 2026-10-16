import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeTypes, NodeProps, Node } from "@xyflow/react";
import { ReactFlow, Background, Position, Handle, useReactFlow } from "@xyflow/react";
import { useLocation, useNavigate } from "@/lib/routing";
import { RunningDot } from "@/components/RunningDot";
import { Badge } from "@/components/ui/badge";
import { ZoomInIcon, ZoomOutIcon, Maximize2Icon } from "lucide-react";
import { MAX_TREE_DEPTH, useChildSessions, type ChildSessionInfo } from "@/hooks/useChildSessions";
import { useSession } from "@/hooks/useSession";
import { cn } from "@/lib/utils";
import { nativeCodingAgentForWrapper, WRAPPER_LABEL_KEY } from "@/lib/nativeCodingAgents";
import {
  buildTree,
  layoutTree,
  NODE_WIDTH,
  type AgentActivity,
  type AgentNodeData,
} from "./subagentGraphLayout";
import { activityDotClassName, sessionStatus } from "./subagentStatus";
import {
  layoutTreeLeftRight,
  resolveDirection,
  useElementSize,
  useGraphDirectionSetting,
  type GraphDirectionSetting,
} from "./aeAgentsGraphLayout";
import { AeGraphDirectionButton, useReadableFit } from "./AeAgentsGraphControls";

import "@xyflow/react/dist/style.css";

// Per-activity node border + background tint. The status DOT color is NOT
// defined here — it comes from the shared ``activityDotClassName`` so the
// graph dot always matches the list dot (the source of truth).
const ACTIVITY_TINT: Record<AgentActivity, { border: string; bg: string }> = {
  working: { border: "border-brand-accent", bg: "bg-brand-accent/5" },
  awaiting: { border: "border-warning", bg: "bg-warning/5" },
  failed: { border: "border-destructive", bg: "bg-destructive/5" },
  launching: { border: "border-muted-foreground/40", bg: "bg-muted/30" },
  disconnected: { border: "border-muted-foreground/30", bg: "bg-card" },
  done: { border: "border-muted-foreground/30", bg: "bg-card" },
  idle: { border: "border-muted-foreground/30", bg: "bg-card" },
  other: { border: "border-muted-foreground/30", bg: "bg-card" },
};

function NodeStatusDot({ activity }: { activity: AgentActivity }) {
  if (activity === "working") return <RunningDot />;
  if (activity === "awaiting") {
    return (
      <Badge className="border-transparent bg-warning/15 text-warning text-[9px] px-1 py-0">
        !
      </Badge>
    );
  }
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", activityDotClassName(activity))}
    />
  );
}

function AgentNodeComponent({ data }: NodeProps<Node<AgentNodeData>>) {
  const { label, activity, statusLabel, isActive, preview } = data;
  const tint = ACTIVITY_TINT[activity];
  const sideways = data.direction === "lr";

  return (
    <>
      <Handle
        type="target"
        position={sideways ? Position.Left : Position.Top}
        className="!bg-muted-foreground/40 !w-1.5 !h-1.5 !border-0"
      />
      <div
        className={cn(
          "rounded-lg border px-3 py-2 shadow-sm transition-colors hover:shadow-md cursor-pointer",
          tint.border,
          tint.bg,
          isActive && "ring-2 ring-ring ring-offset-1 ring-offset-background",
        )}
        style={{ width: NODE_WIDTH }}
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium leading-tight">{label}</span>
          <span className="flex-1" />
          <NodeStatusDot activity={activity} />
        </div>
        {preview && (
          <p className="mt-1 truncate text-[10px] leading-tight text-muted-foreground">{preview}</p>
        )}
        {!["idle", "done"].includes(activity) && (
          <p className="mt-0.5 text-[10px] text-muted-foreground">{statusLabel}</p>
        )}
      </div>
      <Handle
        type="source"
        position={sideways ? Position.Right : Position.Bottom}
        className="!bg-muted-foreground/40 !w-1.5 !h-1.5 !border-0"
      />
    </>
  );
}

function ZoomControls({
  onFit,
  direction,
  onCycleDirection,
}: {
  onFit: () => void;
  direction: GraphDirectionSetting;
  onCycleDirection: () => void;
}) {
  const { zoomIn, zoomOut } = useReactFlow();
  const btnClass =
    "flex items-center justify-center size-8 pointer-coarse:size-10 rounded-md border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-accent-foreground transition-colors";
  return (
    <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-1">
      <button
        type="button"
        className={btnClass}
        onClick={() => zoomIn({ duration: 200 })}
        aria-label="Zoom in"
      >
        <ZoomInIcon className="size-4" />
      </button>
      <button
        type="button"
        className={btnClass}
        onClick={() => zoomOut({ duration: 200 })}
        aria-label="Zoom out"
      >
        <ZoomOutIcon className="size-4" />
      </button>
      <button type="button" className={btnClass} onClick={onFit} aria-label="Fit view">
        <Maximize2Icon className="size-4" />
      </button>
      <AeGraphDirectionButton setting={direction} onCycle={onCycleDirection} className={btnClass} />
    </div>
  );
}

// Lives inside <ReactFlow> because the readable fit needs its store.
function ReadableZoomControls({
  rootId,
  direction,
  pane,
  directionSetting,
  onCycleDirection,
}: {
  rootId: string;
  direction: "tb" | "lr";
  pane: { width: number; height: number };
  directionSetting: GraphDirectionSetting;
  onCycleDirection: () => void;
}) {
  const fit = useReadableFit(rootId, direction, pane);
  return (
    <ZoomControls onFit={fit} direction={directionSetting} onCycleDirection={onCycleDirection} />
  );
}

const nodeTypes: NodeTypes = { agent: AgentNodeComponent };

function ChildCollector({
  parentId,
  depth,
  onCollected,
}: {
  parentId: string;
  depth: number;
  onCollected: (parentId: string, children: ChildSessionInfo[]) => void;
}) {
  const { children } = useChildSessions(depth < MAX_TREE_DEPTH ? parentId : null);

  useEffect(() => {
    onCollected(parentId, children);
  }, [parentId, children, onCollected]);

  if (depth >= MAX_TREE_DEPTH) return null;
  return (
    <>
      {children.map((child) => (
        <ChildCollector
          key={child.id}
          parentId={child.id}
          depth={depth + 1}
          onCollected={onCollected}
        />
      ))}
    </>
  );
}

interface SubagentsGraphViewProps {
  conversationId: string;
  rootSessionId: string;
}

export function SubagentsGraphView({ conversationId, rootSessionId }: SubagentsGraphViewProps) {
  const { session } = useSession(rootSessionId);
  const { children: rootChildren } = useChildSessions(rootSessionId);

  const [childrenMap, setChildrenMap] = useState<Map<string, ChildSessionInfo[]>>(() => new Map());

  const prevRootRef = useRef<ChildSessionInfo[] | undefined>(undefined);
  if (prevRootRef.current !== rootChildren) {
    prevRootRef.current = rootChildren;
    if (childrenMap.get(rootSessionId) !== rootChildren) {
      const next = new Map(childrenMap);
      next.set(rootSessionId, rootChildren);
      setChildrenMap(next);
    }
  }

  const handleCollected = useCallback((parentId: string, children: ChildSessionInfo[]) => {
    setChildrenMap((prev) => {
      if (prev.get(parentId) === children) return prev;
      const next = new Map(prev);
      next.set(parentId, children);
      return next;
    });
  }, []);

  const wrapper = session?.labels?.[WRAPPER_LABEL_KEY];
  const nativeAgent = nativeCodingAgentForWrapper(wrapper);
  const rootLabel = nativeAgent?.displayName ?? session?.agentName ?? "main";
  // Mirror the list view's ``sessionStatus`` so the root node honors
  // launching / disconnected (not just running / failed / idle).
  const rootStatus = sessionStatus(session?.status, session?.lastTaskError);
  const rootActivity = rootStatus.activity;
  const rootStatusLabel = rootStatus.label;

  const [paneElement, setPaneElement] = useState<HTMLDivElement | null>(null);
  const paneSize = useElementSize(paneElement);
  const [directionSetting, cycleDirection] = useGraphDirectionSetting();
  const direction = resolveDirection(directionSetting, paneSize.width, paneSize.height);

  const { nodes: layoutNodes, edges: layoutEdges } = useMemo(() => {
    const tree = buildTree(
      rootSessionId,
      rootLabel,
      rootActivity,
      rootStatusLabel,
      null,
      childrenMap,
      0,
    );
    const layout =
      direction === "lr"
        ? layoutTreeLeftRight(tree, conversationId)
        : layoutTree(tree, conversationId);
    return {
      nodes: layout.nodes.map((n) => ({ ...n, data: { ...n.data, direction } })),
      edges: layout.edges,
    };
  }, [
    rootSessionId,
    rootLabel,
    rootActivity,
    rootStatusLabel,
    childrenMap,
    conversationId,
    direction,
  ]);

  const navigate = useNavigate();
  const location = useLocation();
  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node<AgentNodeData>) => {
      const params = new URLSearchParams(location.search);
      for (const key of ["file", "diff", "comment", "view", "message"]) params.delete(key);
      const search = params.toString();
      navigate({
        pathname: `/c/${node.data.sessionId}`,
        search: search ? `?${search}` : "",
      });
    },
    [navigate, location.search],
  );

  return (
    <div
      data-workspace-panel-surface
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-card"
    >
      <div ref={setPaneElement} className="h-full w-full" style={{ minHeight: 200 }}>
        <ReactFlow
          nodes={layoutNodes}
          edges={layoutEdges}
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
          panOnDrag
          panOnScroll
          zoomOnDoubleClick={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          minZoom={0.1}
          maxZoom={3}
        >
          <Background bgColor="var(--card)" />
          <ReadableZoomControls
            rootId={rootSessionId}
            direction={direction}
            pane={paneSize}
            directionSetting={directionSetting}
            onCycleDirection={cycleDirection}
          />
        </ReactFlow>
      </div>
      {rootChildren.map((child) => (
        <ChildCollector
          key={child.id}
          parentId={child.id}
          depth={1}
          onCollected={handleCollected}
        />
      ))}
    </div>
  );
}
