// The rail's Usage section: both plans' limits, the session's own plan first
// and tagged, with the same rows as the usage popover.

import { useAePickedClaudeAccount } from "@/hooks/useAePickedClaudeAccount";
import { type AeRailSectionProps, useAeRailSectionActive } from "@/lib/aeSessionRail";
import { useChatStore } from "@/store/chatStore";
import {
  type AeHarness,
  type AeLimitsAnswer,
  AeLimitsHarnessBlock,
  aeLimitsErrorText,
  useAeLimits,
} from "../AePlanLimits";
import { aeLimitsHarnessFor } from "../aeSessionContext";
import { AeRailSection } from "./AeRailSection";
import { AeRailMuted } from "./aeRailUi";
import { useAeRailNow } from "./aeRailNow";

/** A window's short name for the section summary: "5-hour", "Weekly", "Weekly Fable". */
function shortLabel(id: string, label: string): string {
  if (id === "five_hour" || /^5-hour/i.test(label)) return "5-hour";
  const model = /^Weekly\s*·\s*(.+)$/.exec(label)?.[1];
  if (model) return `Weekly ${model}`;
  if (/^Weekly/i.test(label)) return "Weekly";
  return label;
}

/** The fullest window or credit line across both plans, once it reaches 80 percent. */
export function usageSummary(data: AeLimitsAnswer | undefined): string | null {
  let best: { label: string; pct: number } | null = null;
  for (const snapshot of Object.values(data?.harnesses ?? {})) {
    if (!snapshot) continue;
    const rows = snapshot.windows.map((w) => ({
      label: shortLabel(w.id, w.label),
      pct: w.used_percent,
    }));
    const credits = snapshot.credits;
    if (credits?.enabled && credits.used_percent != null) {
      rows.push({ label: "Credits", pct: credits.used_percent });
    }
    for (const row of rows) if (!best || row.pct > best.pct) best = row;
  }
  return best && best.pct >= 80 ? `${best.label} ${Math.round(best.pct)}%` : null;
}

export function AeRailUsage({ sessionId }: AeRailSectionProps) {
  // The store's harness belongs to its own conversation; another session's is unknown here.
  const harness = useChatStore((s) => (s.conversationId === sessionId ? s.sessionHarness : null));
  const active = useAeRailSectionActive("usage");
  const picked = useAePickedClaudeAccount(
    sessionId,
    active && aeLimitsHarnessFor(harness) === "claude",
  );
  const { data, error, loading } = useAeLimits(active && picked.ready, sessionId, picked.account);
  const now = useAeRailNow(active);
  const inUse = aeLimitsHarnessFor(harness);
  const order: AeHarness[] = inUse === "codex" ? ["codex", "claude"] : ["claude", "codex"];
  const summary = usageSummary(data);
  return (
    <AeRailSection
      id="usage"
      summary={summary ? <span className="text-destructive">{summary}</span> : undefined}
    >
      <div className="flex flex-col gap-4 text-sm" data-testid="ae-rail-usage">
        {error ? (
          <AeRailMuted className="text-destructive">{aeLimitsErrorText(error)}</AeRailMuted>
        ) : !data ? (
          <AeRailMuted>{loading || active ? "Loading…" : "No reading yet."}</AeRailMuted>
        ) : (
          order.map((h) => (
            <AeLimitsHarnessBlock
              key={h}
              harness={h}
              snapshot={data.harnesses[h]}
              sessionId={sessionId}
              now={now}
              inUse={inUse === h}
              short
            />
          ))
        )}
      </div>
    </AeRailSection>
  );
}
