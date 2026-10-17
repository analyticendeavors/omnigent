// Where the session runs: host and liveness, workspace folder, git branch,
// and permission mode. Unknowns are said plainly rather than guessed.

import { resolveHostBadge } from "@/components/HostBadge";
import { useSessionHostOnline, useSessionRunnerOnline } from "@/hooks/RunnerHealthProvider";
import { useHosts } from "@/hooks/useHosts";
import { useSession } from "@/hooks/useSession";
import { useWorkspaceEnvironment } from "@/hooks/useWorkspaceChangedFiles";
import { claudePermissionModeFromSession } from "@/lib/claudePermissionMode";
import { codexApprovalModeFromSession } from "@/lib/codexApprovalMode";
import { type AeRailSectionProps, useAeRailSectionActive } from "@/lib/aeSessionRail";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";
import { AeRailSection } from "./AeRailSection";
import { aeRailFolderParts, aeRailHarnessKind, aeRailPermissionLabel } from "./aeRailModel";
import { useAeRailGithubInfo } from "./aeRailQueries";
import { AeRailMeta, AeRailRow } from "./aeRailUi";

const DOT: Record<"online" | "offline" | "unknown", { className: string; word: string }> = {
  online: { className: "bg-success", word: "online" },
  offline: { className: "bg-destructive", word: "offline" },
  unknown: { className: "bg-muted-foreground/50", word: "status unknown" },
};

export function AeRailEnvironment({ sessionId }: AeRailSectionProps) {
  const active = useAeRailSectionActive("environment");
  const { session } = useSession(sessionId);
  const hostId = session?.hostId ?? null;
  const { data: hosts } = useHosts({ includeSandbox: true, enabled: active && !!hostId });
  const hostOnline = useSessionHostOnline(sessionId);
  const runnerOnline = useSessionRunnerOnline(sessionId);
  const host = hostId ? hosts?.find((h) => h.host_id === hostId) : undefined;
  const badge = resolveHostBadge({
    hostId,
    host,
    online: hostOnline === undefined && host ? host.status === "online" : hostOnline,
  });
  const hostLabel = badge?.label ?? (session ? "Local session" : null);
  const liveness = badge
    ? badge.status
    : runnerOnline === true
      ? "online"
      : runnerOnline === false
        ? "offline"
        : "unknown";

  const environment = useWorkspaceEnvironment(sessionId, { enabled: active });
  const folder = environment.data?.root ?? session?.workspace ?? null;
  const folderParts = folder ? aeRailFolderParts(folder, environment.data?.home) : null;

  const github = useAeRailGithubInfo(sessionId, active);
  const branch = github.data?.branch || session?.gitBranch || null;
  const notGit = github.data?.available === false && github.data.reason === "not_a_git_repo";
  const worktree = !!session?.gitBranch;

  const storeFocused = useChatStore((s) => s.conversationId === sessionId);
  const storeHarness = useChatStore((s) => s.sessionHarness);
  const storeClaudeMode = useChatStore((s) => s.claudePermissionMode);
  const storeCodexMode = useChatStore((s) => s.codexApprovalMode);
  const kind = aeRailHarnessKind((storeFocused ? storeHarness : null) ?? session?.harness ?? null);
  const permission = aeRailPermissionLabel(
    kind,
    storeFocused && storeClaudeMode ? storeClaudeMode : claudePermissionModeFromSession(session),
    storeFocused && storeCodexMode ? storeCodexMode : codexApprovalModeFromSession(session),
  );

  const folded = [hostLabel, branch].filter(Boolean).join(" · ") || undefined;
  const dot = DOT[liveness];
  return (
    <AeRailSection id="environment" foldedSummary={folded}>
      <AeRailRow
        icon="server"
        title={hostLabel ? `${hostLabel}: ${dot.word}` : undefined}
        trailing={
          <span
            role="img"
            aria-label={`Host ${dot.word}`}
            className={cn("size-2 shrink-0 rounded-full", dot.className)}
          />
        }
      >
        {hostLabel ?? <span className="text-muted-foreground">Host unknown</span>}
      </AeRailRow>
      <AeRailRow icon="folder" title={folder ?? undefined}>
        {folderParts ? (
          <>
            {folderParts.name}
            {folderParts.parent && (
              <span className="ml-1.5 text-muted-foreground">{folderParts.parent}</span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">No workspace folder reported</span>
        )}
      </AeRailRow>
      <AeRailRow
        icon="gitBranch"
        title={branch ?? undefined}
        trailing={
          worktree ? (
            <span className="shrink-0 rounded border border-border px-1.5 text-[11px] leading-4 text-muted-foreground">
              worktree
            </span>
          ) : undefined
        }
      >
        {branch ?? (
          <span className="text-muted-foreground">
            {notGit ? "Not a git repository" : "Branch unknown"}
          </span>
        )}
      </AeRailRow>
      <AeRailRow icon="shield" trailing={permission ? <AeRailMeta>permissions</AeRailMeta> : null}>
        {permission ?? (
          <span className="text-muted-foreground">
            {kind === "other"
              ? "Permission mode not reported for this harness"
              : "Permission mode not reported yet"}
          </span>
        )}
      </AeRailRow>
    </AeRailSection>
  );
}
