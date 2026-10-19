// MCP servers and their status. Claude Code's come from the shared context
// snapshot (the popover's probe), Codex's from its last startup report.

import { aeContextIdentity, useAeContextSnapshot } from "@/components/aeContextUsage";
import { useSession } from "@/hooks/useSession";
import { relativeTime } from "@/lib/relativeTime";
import { type AeRailSectionProps, useAeRailSectionActive } from "@/lib/aeSessionRail";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";
import { AeRailSection } from "./AeRailSection";
import { useAeRailNow } from "./aeRailNow";
import {
  aeRailConnectorCounts,
  aeRailConnectorRows,
  aeRailHarnessKind,
  type AeRailMcpTone,
} from "./aeRailModel";
import { useAeRailCodexMcp } from "./aeRailQueries";
import { AE_RAIL_TONE_TEXT, AeRailIcon, AeRailMeta, AeRailMuted, AeRailRow } from "./aeRailUi";

const TONE_DOT: Record<AeRailMcpTone, string> = {
  ok: "bg-success",
  err: "bg-destructive",
  warn: "bg-warning",
  muted: "bg-muted-foreground/50",
};

const TONE_WORD: Record<AeRailMcpTone, string | undefined> = {
  ok: undefined,
  err: "text-destructive",
  warn: AE_RAIL_TONE_TEXT.warning,
  muted: undefined,
};

interface Source {
  servers: { name: string; status: string }[] | undefined;
  observedAt: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function useConnectorSource(sessionId: string, active: boolean): Source & { kind: string } {
  const { session } = useSession(sessionId);
  const focused = useChatStore((s) => s.conversationId === sessionId);
  const storeHarness = useChatStore((s) => s.sessionHarness);
  const storeModel = useChatStore((s) => s.llmModel);
  const harness = (focused ? storeHarness : null) ?? session?.harness ?? null;
  const model = (focused ? storeModel : null) ?? session?.llmModel ?? null;
  const kind = aeRailHarnessKind(harness);
  const snapshot = useAeContextSnapshot(kind === "claude" ? sessionId : null, {
    enabled: active && kind === "claude",
    identity: aeContextIdentity(harness, model),
  });
  const codex = useAeRailCodexMcp(sessionId, active && kind === "codex");
  if (kind === "claude") {
    const data = snapshot.data;
    return {
      kind,
      servers: data?.available ? data.mcpServers : undefined,
      observedAt: data?.available ? data.observedAt : null,
      // `loading` covers the quiet retries while Claude starts, so no error shows then.
      loading: snapshot.loading,
      error: snapshot.pending
        ? null
        : (snapshot.error ?? (data && !data.available ? (data.reason ?? null) : null)),
      refresh: snapshot.refresh,
    };
  }
  if (kind === "codex") {
    return {
      kind,
      servers: codex.data?.available ? codex.data.servers : undefined,
      observedAt: codex.data?.observedAt ?? null,
      loading: codex.isFetching && !codex.data,
      error: codex.error ? codex.error.message : null,
      refresh: () => void codex.refetch(),
    };
  }
  return { kind, servers: undefined, observedAt: null, loading: false, error: null, refresh() {} };
}

export function AeRailConnectors({ sessionId }: AeRailSectionProps) {
  const active = useAeRailSectionActive("connectors");
  const source = useConnectorSource(sessionId, active);
  const now = useAeRailNow(active);
  const rows = aeRailConnectorRows(source.servers);
  const counts = aeRailConnectorCounts(rows);
  const summary =
    counts.total === 0 ? undefined : counts.failed > 0 ? (
      <span className="text-destructive">
        {counts.failed} of {counts.total} failed
      </span>
    ) : (
      `${counts.connected} connected`
    );
  const observed = source.observedAt ? Date.parse(source.observedAt) : Number.NaN;
  const age = Number.isFinite(observed) ? relativeTime(observed, now) : "";

  let body;
  if (source.kind === "other") {
    body = (
      <AeRailMuted>Connector status is reported for Claude Code and Codex sessions.</AeRailMuted>
    );
  } else if (rows.length > 0) {
    body = rows.map((row) => (
      <AeRailRow
        key={row.name}
        title={`${row.name}: ${row.word}`}
        icon={
          <span
            aria-hidden="true"
            className={cn("ml-1 mr-0.5 size-2 shrink-0 rounded-full", TONE_DOT[row.tone])}
          />
        }
        trailing={<AeRailMeta className={TONE_WORD[row.tone]}>{row.word}</AeRailMeta>}
      >
        {row.name}
      </AeRailRow>
    ));
  } else if (source.loading) {
    body = <AeRailMuted>Checking connectors…</AeRailMuted>;
  } else if (source.error) {
    body = <AeRailMuted>{source.error}</AeRailMuted>;
  } else if (source.servers) {
    body = <AeRailMuted>No MCP servers configured for this session.</AeRailMuted>;
  } else if (source.kind === "codex") {
    body = (
      <AeRailMuted>
        No connector report yet. Codex reports its MCP servers as it starts.
      </AeRailMuted>
    );
  } else {
    body = (
      <AeRailMuted>
        No connector report yet. Refresh to check, or update the runner if it stays empty.
      </AeRailMuted>
    );
  }

  return (
    <AeRailSection id="connectors" summary={summary}>
      {body}
      {source.kind !== "other" && (
        <div className="mt-1 flex items-center gap-2">
          <AeRailMeta className="min-w-0 flex-1 truncate">
            {age ? (age === "now" ? "Checked just now" : `Checked ${age} ago`) : ""}
          </AeRailMeta>
          <button
            type="button"
            onClick={source.refresh}
            disabled={source.loading}
            aria-label="Refresh connector status"
            title="Refresh connector status"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 pointer-coarse:size-9"
          >
            <AeRailIcon
              name={source.loading ? "loader" : "refresh"}
              className={cn("size-3.5", source.loading && "animate-spin")}
            />
          </button>
        </div>
      )}
    </AeRailSection>
  );
}
