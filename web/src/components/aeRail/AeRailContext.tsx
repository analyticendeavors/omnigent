// The rail's Context section: Claude Code's category snapshot in full (rows by
// size, deferred tools, the tool, memory, skill and agent lists), the
// auto-compact countdown with Compact beside it, and the snapshot's age. Other
// harnesses get the plain context bar from the chat store.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { contextTone } from "@/lib/aeContextTone";
import { type AeRailSectionProps, useAeRailSectionActive } from "@/lib/aeSessionRail";
import { isNativeHarness } from "@/lib/forkHarness";
import { cn } from "@/lib/utils";
import { useTerminalFirst } from "@/shell/TerminalFirstContext";
import { useChatStore } from "@/store/chatStore";
import { AeCategoryBar, AeContextCategoryRows } from "../AeContextCategories";
import { formatAgo, formatTokens } from "../AePlanLimits";
import {
  type AeContextSnapshotState,
  aeContextIdentity,
  type ContextUsage,
  contextCountdown,
  useAeContextSnapshot,
} from "../aeContextUsage";
import { aeModelName } from "../aeSessionContext";
import { AeRailSection } from "./AeRailSection";
import { AE_RAIL_TONE_TEXT, AeRailBar, AeRailIcon, AeRailMeta, AeRailMuted } from "./aeRailUi";
import { useAeRailNow } from "./aeRailNow";

export function isClaudeCodeHarness(harness: string | null | undefined): boolean {
  return harness === "claude-native" || harness === "native-claude";
}

/** Where ChatPage offers /compact: native wrappers and claude-sdk. */
function useCanCompact(harness: string | null): boolean {
  const terminalFirst = useTerminalFirst();
  const nativeWrapper = terminalFirst ? terminalFirst.isNativeWrapper : isNativeHarness(harness);
  return nativeWrapper || harness === "claude-sdk";
}

export function AeRailContext({ sessionId }: AeRailSectionProps) {
  const storeSession = useChatStore((s) => s.conversationId);
  // The store's harness and model belong to its own conversation; elsewhere they are unknown.
  const harness = useChatStore((s) => (s.conversationId === sessionId ? s.sessionHarness : null));
  const model = useChatStore((s) => (s.conversationId === sessionId ? s.llmModel : null));
  const contextWindow = useChatStore((s) => s.contextWindow);
  const tokensUsed = useChatStore((s) => s.tokensUsed);
  const active = useAeRailSectionActive("context");
  const native = isClaudeCodeHarness(harness);
  const canCompact = useCanCompact(harness) && storeSession === sessionId;
  const snapshot = useAeContextSnapshot(sessionId, {
    enabled: active && native,
    identity: aeContextIdentity(harness, model),
  });
  const data = native && snapshot.data?.available ? snapshot.data : undefined;
  // A cached snapshot speaks for the headline only while fresh; older, the live reading does.
  const headline = data && snapshot.fresh ? data : undefined;
  const live =
    storeSession === sessionId && contextWindow && contextWindow > 0 && tokensUsed != null
      ? { used: tokensUsed, size: contextWindow }
      : null;
  const reading = headline ? { used: headline.totalTokens, size: headline.maxTokens } : live;
  const pct = reading ? (reading.used / reading.size) * 100 : null;
  return (
    <AeRailSection
      id="context"
      foldedSummary={pct === null ? undefined : `${Math.round(pct)}% used`}
    >
      <div className="flex flex-col gap-2 text-sm" data-testid="ae-rail-context">
        {reading && pct !== null ? (
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn("font-semibold", AE_RAIL_TONE_TEXT[contextTone(pct)])}>
              {Math.round(pct)}% used
            </span>
            <AeRailMeta className="tabular-nums">
              {formatTokens(reading.used)} / {formatTokens(reading.size)}
            </AeRailMeta>
          </div>
        ) : (
          <AeRailMuted>No reading yet; it appears after the session's next reply.</AeRailMuted>
        )}
        {data ? (
          <SnapshotBody
            // A new session starts with its folds shut.
            key={sessionId}
            data={data}
            snapshot={snapshot}
            model={model}
            active={active}
            canCompact={canCompact}
          />
        ) : (
          <>
            {pct !== null && <AeRailBar pct={pct} />}
            {native ? (
              <SnapshotStatus snapshot={snapshot} />
            ) : (
              <AeRailMuted>A category breakdown is available for Claude Code sessions.</AeRailMuted>
            )}
          </>
        )}
      </div>
    </AeRailSection>
  );
}

/** No snapshot to draw yet: loading, failed, or unavailable on this runner. */
function SnapshotStatus({ snapshot }: { snapshot: AeContextSnapshotState }) {
  // Claude is still starting and the store is retrying: loading, never "Try again".
  if (snapshot.pending) return <AeRailMuted>Reading context categories…</AeRailMuted>;
  const unavailable = snapshot.data && !snapshot.data.available ? snapshot.data : null;
  // Retrying cannot change a final answer, so it gets no button.
  if (!snapshot.error && unavailable?.final && unavailable.reason) {
    return <AeRailMuted>{unavailable.reason}</AeRailMuted>;
  }
  if (snapshot.error || unavailable) {
    return (
      <TryAgain
        message={
          snapshot.error ??
          unavailable?.reason ??
          "Claude Code could not take a context snapshot. Try again."
        }
        onRetry={snapshot.refresh}
        busy={snapshot.loading}
        destructive={Boolean(snapshot.error)}
      />
    );
  }
  return <AeRailMuted>Reading context categories…</AeRailMuted>;
}

function TryAgain({
  message,
  onRetry,
  busy,
  destructive,
}: {
  message: string;
  onRetry: () => void;
  busy: boolean;
  destructive: boolean;
}) {
  return (
    <div className="flex items-start gap-2" role="status">
      <p
        className={cn(
          "min-w-0 flex-1 text-xs",
          destructive ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {message}
      </p>
      <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function SnapshotBody({
  data,
  snapshot,
  model,
  active,
  canCompact,
}: {
  data: ContextUsage;
  snapshot: AeContextSnapshotState;
  model: string | null;
  active: boolean;
  canCompact: boolean;
}) {
  const now = useAeRailNow(active);
  const countdown = contextCountdown(data, data.totalTokens);
  const meta = ["Estimated snapshot", aeModelName(model), formatAgo(data.observedAt, now)]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <AeCategoryBar data={data} />
      <AeContextCategoryRows data={data} />
      {!data.complete && (
        <AeRailMuted>
          Some MCP servers are unavailable or still connecting. Their tools may be missing.
        </AeRailMuted>
      )}
      {(countdown || canCompact) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
          <span
            // basis-0 so the line never wraps for the text; it truncates instead.
            className="min-w-0 flex-1 basis-0 truncate text-xs text-muted-foreground"
            data-testid="ae-rail-countdown"
            title={countdown ?? undefined}
          >
            {countdown}
          </span>
          {canCompact && <CompactButton />}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <AeRailMeta className="min-w-0 flex-1">{meta}</AeRailMeta>
        <button
          type="button"
          aria-label="Refresh snapshot"
          title="Refresh snapshot"
          disabled={snapshot.loading}
          onClick={snapshot.refresh}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60 pointer-coarse:size-9"
        >
          <AeRailIcon
            name={snapshot.loading ? "loader" : "refresh"}
            className={cn("size-3.5", snapshot.loading && "animate-spin")}
          />
        </button>
      </div>
      {snapshot.error && (
        <TryAgain
          message={snapshot.error}
          onRetry={snapshot.refresh}
          busy={snapshot.loading}
          destructive
        />
      )}
    </>
  );
}

type CompactPhase = "idle" | "confirm" | "running";

/** Two clicks within three seconds compact the session, as /compact does. */
export function CompactButton() {
  const [phase, setPhase] = useState<CompactPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (phase !== "confirm") return undefined;
    const timer = window.setTimeout(() => setPhase("idle"), 3000);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const onClick = () => {
    if (phase === "idle") {
      setError(null);
      setPhase("confirm");
      return;
    }
    if (phase !== "confirm") return;
    setPhase("running");
    useChatStore
      .getState()
      .compact()
      .then(
        () => setPhase("idle"),
        (reason: unknown) => {
          const detail = reason instanceof Error ? reason.message : String(reason);
          setError(
            `Could not compact the session (${detail}). Try again, or send /compact from the composer.`,
          );
          setPhase("idle");
        },
      );
  };
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant={phase === "confirm" ? "destructive" : "outline"}
        disabled={phase === "running"}
        onClick={onClick}
        data-testid="ae-rail-compact"
        className="shrink-0"
      >
        {phase === "confirm"
          ? "Compact now?"
          : phase === "running"
            ? "Compacting..."
            : "Compact"}
      </Button>
      {error && (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
