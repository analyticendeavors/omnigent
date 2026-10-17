// Pull requests linked to the session, then the session's changed files as
// one totals line. A pull request row opens it on GitHub in a new tab.

import { useWorkspaceChangedFiles } from "@/hooks/useWorkspaceChangedFiles";
import { type AeRailSectionProps, useAeRailSectionActive } from "@/lib/aeSessionRail";
import { cn } from "@/lib/utils";
import { AeRailSection } from "./AeRailSection";
import { useAeRailOpenWorkspaceTab } from "./aeRailActions";
import type { AeRailIconName } from "./aeRailIcons";
import {
  aeRailChangeTotals,
  aeRailChangesError,
  aeRailCount,
  aeRailPrMeta,
  aeRailPrState,
  type AeRailPrState,
} from "./aeRailModel";
import { useAeRailGithubInfo, useAeRailPrs } from "./aeRailQueries";
import { AeRailIcon, AeRailMuted, AeRailRow } from "./aeRailUi";

const PR_ICON: Record<AeRailPrState, { icon: AeRailIconName; tone: string; label: string }> = {
  open: {
    icon: "prOpen",
    tone: "text-emerald-600 dark:text-emerald-400",
    label: "Open pull request",
  },
  draft: { icon: "prDraft", tone: "text-muted-foreground", label: "Draft pull request" },
  merged: {
    icon: "prMerged",
    tone: "text-purple-700 dark:text-purple-400",
    label: "Merged pull request",
  },
  closed: { icon: "prClosed", tone: "text-destructive", label: "Closed pull request" },
  unknown: { icon: "prOpen", tone: "text-muted-foreground", label: "Pull request" },
};

export function AeRailChanges({ sessionId }: AeRailSectionProps) {
  const active = useAeRailSectionActive("changes");
  const github = useAeRailGithubInfo(sessionId, active);
  const prs = useAeRailPrs(github.data, active);
  const changes = useWorkspaceChangedFiles(sessionId, { enabled: active });
  const totals = aeRailChangeTotals(changes.data?.data);
  const openTab = useAeRailOpenWorkspaceTab();

  const summary =
    prs.length > 0
      ? aeRailCount(prs.length, "PR", "PRs")
      : totals.files > 0
        ? aeRailCount(totals.files, "file", "files")
        : undefined;

  const empty = prs.length === 0 && totals.files === 0;
  return (
    <AeRailSection id="changes" summary={summary}>
      {prs.map((pr) => {
        const state = PR_ICON[aeRailPrState(pr.card)];
        return (
          <a
            key={pr.url}
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`${state.label}: open on GitHub`}
            className="-mx-1.5 flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted"
          >
            <span className="sr-only">{state.label}</span>
            <AeRailIcon name={state.icon} className={cn("mt-0.5", state.tone)} />
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 break-words">
                {pr.title ?? `Pull request #${pr.number}`}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {aeRailPrMeta(pr.repository, pr.number, pr.card)}
              </span>
            </span>
          </a>
        );
      })}
      {github.error && prs.length === 0 && (
        <AeRailMuted>
          Could not load pull requests: {github.error.message}. Reopen this section to retry.
        </AeRailMuted>
      )}
      {totals.files > 0 && (
        <AeRailRow
          icon="fileDiff"
          title={
            openTab ? "Open the Changes tab" : "Lines added and removed across the session's files"
          }
          onClick={openTab ? () => openTab("changes") : undefined}
          trailing={
            openTab ? (
              <AeRailIcon name="chevronRight" className="size-3.5 text-muted-foreground" />
            ) : undefined
          }
        >
          {aeRailCount(totals.files, "file", "files")} changed
          {totals.counted && (
            <>
              {" "}
              <span className="text-emerald-600 dark:text-emerald-400">+{totals.added}</span>{" "}
              <span className="text-destructive">−{totals.removed}</span>
            </>
          )}
        </AeRailRow>
      )}
      {changes.error && totals.files === 0 && (
        <AeRailMuted>{aeRailChangesError(changes.error)}</AeRailMuted>
      )}
      {empty && !github.error && !changes.error && (
        <AeRailMuted>No pull requests or changed files yet.</AeRailMuted>
      )}
    </AeRailSection>
  );
}
