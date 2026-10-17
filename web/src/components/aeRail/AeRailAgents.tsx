// The rail's Agents section: each collaborator's own context window (never
// summed) and a count of Claude Code's subagents, which report no reading.

import { type AeRailSectionProps, useAeRailSectionActive } from "@/lib/aeSessionRail";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";
import { useAeLimits } from "../AePlanLimits";
import { aeContextIdentity } from "../aeContextUsage";
import {
  type AeContextEntry,
  aeModelName,
  buildCollaboratorContext,
  useAeSessionContexts,
} from "../aeSessionContext";
import { AeRailSection } from "./AeRailSection";
import { useAeRailOpenWorkspaceTab } from "./aeRailActions";
import { AeRailBar, AeRailIcon, AeRailMuted, AeRailRow } from "./aeRailUi";

/** The popover's own cadence; the section never polls faster. */
const POLL_MS = 60_000;

function who(entry: AeContextEntry): string | null {
  return [entry.agent, aeModelName(entry.model)].filter(Boolean).join(" · ") || null;
}

export function AeRailAgents({ sessionId }: AeRailSectionProps) {
  const harness = useChatStore((s) => (s.conversationId === sessionId ? s.sessionHarness : null));
  const model = useChatStore((s) => (s.conversationId === sessionId ? s.llmModel : null));
  const active = useAeRailSectionActive("agents");
  const sessions = useAeSessionContexts(
    active,
    sessionId,
    POLL_MS,
    aeContextIdentity(harness, model),
  );
  // Claude Code collaborators report their window through the limits relay's status lines.
  const statusLines = useAeLimits(active, sessionId).data?.harnesses.claude?.contexts;
  const subagents = sessions.subagents ?? 0;
  const openTab = useAeRailOpenWorkspaceTab();
  const now = Date.now();
  const rows = sessions.collaborators.map((c) => ({
    running: c.running !== false,
    entry: buildCollaboratorContext(c, statusLines, now),
  }));
  const running = rows.filter((r) => r.running).length + subagents;
  const hidden = sessions.hidden ?? 0;
  const empty = rows.length === 0 && subagents === 0;
  return (
    <AeRailSection id="agents" summary={running > 0 ? `${running} running` : undefined}>
      <div className="flex flex-col gap-2 text-sm" data-testid="ae-rail-agents">
        {rows.map(({ entry, running: live }) => {
          const pct = entry.reading ? (entry.reading.used / entry.reading.size) * 100 : null;
          const detail = [who(entry), live ? null : "finished"].filter(Boolean).join(" · ");
          return (
            <div
              key={entry.key}
              className={cn("flex flex-col gap-1", !live && "opacity-70")}
              data-testid="ae-rail-agent"
              data-session={entry.key}
              title={entry.unavailable ?? undefined}
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{entry.name}</span>
                  {detail && (
                    <span className="block truncate text-xs text-muted-foreground">{detail}</span>
                  )}
                </span>
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    pct === null ? "text-xs text-muted-foreground" : "font-semibold",
                  )}
                >
                  {pct === null ? "No reading" : `${Math.round(pct)}%`}
                </span>
              </div>
              <AeRailBar pct={pct ?? 0} />
            </div>
          );
        })}
        {subagents > 0 && (
          <AeRailRow
            icon="robot"
            title={openTab ? "Open the Agents tab" : undefined}
            onClick={openTab ? () => openTab("subagents") : undefined}
            trailing={
              openTab ? (
                <AeRailIcon name="chevronRight" className="size-3.5 text-muted-foreground" />
              ) : undefined
            }
          >
            {subagents} Claude Code {subagents === 1 ? "subagent" : "subagents"}
            <span className="text-muted-foreground"> · no reading</span>
          </AeRailRow>
        )}
        {hidden > 0 && (
          <AeRailMuted>
            {hidden} more {hidden === 1 ? "agent" : "agents"} not shown.
          </AeRailMuted>
        )}
        {sessions.error && (
          <AeRailMuted className="text-destructive">
            Could not list this session's agents ({sessions.error}). The section retries within a
            minute.
          </AeRailMuted>
        )}
        {empty && !sessions.error && (
          <AeRailMuted>
            {sessions.loading ? "Loading agents…" : "No other agents in this session."}
          </AeRailMuted>
        )}
      </div>
    </AeRailSection>
  );
}
