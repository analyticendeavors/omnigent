// The rail's reads, sharing the GitHub panel's and the pull request cards'
// query keys so an open panel and the rail never fetch the same thing twice.
// Each fetches only while its section is on screen; folded, it reads the cache.

import { useEffect, useRef } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { fetchPullRequestInfo, type PullRequestInfo } from "@/hooks/usePullRequests";
import {
  runnerOfflineRetryDelay,
  shouldRetryRunnerOffline,
  useWorkspaceServeable,
} from "@/hooks/useWorkspaceChangedFiles";
import { type AePrCard, fetchAePrCard, parseAePrUrl } from "@/lib/aePrs";
import { authenticatedFetch } from "@/lib/identity";
import { isTempConvId } from "@/lib/tempConversationId";
import { useChatStore } from "@/store/chatStore";

/** The pull request cards' cadence (AE_PR_POLL_MS); the server caches GitHub for a minute. */
const PR_POLL_MS = 30_000;

/** The session's GitHub info (branch, linked pull requests), under the panel's key. */
export function useAeRailGithubInfo(sessionId: string, active: boolean) {
  const id = isTempConvId(sessionId) ? undefined : sessionId;
  const serveable = useWorkspaceServeable(id);
  return useQuery<PullRequestInfo>({
    queryKey: ["github-info", id],
    queryFn: () => fetchPullRequestInfo(id!),
    enabled: active && !!id && serveable !== false,
    retry: shouldRetryRunnerOffline,
    retryDelay: runnerOfflineRetryDelay,
    staleTime: 30_000,
  });
}

export interface AeRailPr {
  url: string;
  repository: string;
  number: number;
  title: string | null;
  card: AePrCard | undefined;
}

/** Linked pull requests, newest first as upstream lists them, each with its card once read. */
export function useAeRailPrs(info: PullRequestInfo | undefined, active: boolean): AeRailPr[] {
  const linked: { url: string; repository: string; number: number; title: string | null }[] = [];
  const seen = new Set<string>();
  const source =
    info?.prs ??
    (info?.pr
      ? [{ url: info.pr.url, repository: "", number: info.pr.number, title: info.pr.title }]
      : []);
  for (const pr of source) {
    if (!pr.url || seen.has(pr.url)) continue;
    seen.add(pr.url);
    const parsed = parseAePrUrl(pr.url);
    linked.push({
      url: pr.url,
      repository: parsed?.repo ?? (pr.repository || info?.repo?.name_with_owner || ""),
      number: parsed?.number ?? pr.number,
      title: pr.title ?? null,
    });
  }
  const cards = useQueries({
    queries: linked.map((pr) => {
      const parsed = parseAePrUrl(pr.url);
      return {
        queryKey: ["ae-pr", parsed?.repo, parsed?.number],
        queryFn: () => fetchAePrCard(parsed!.repo, parsed!.number),
        enabled: active && parsed !== null,
        refetchInterval: active ? PR_POLL_MS : (false as const),
        retry: false,
      };
    }),
  });
  return linked.map((pr, index) => ({
    ...pr,
    card: cards[index]?.data,
    title: cards[index]?.data?.title ?? pr.title,
  }));
}

export interface AeRailCodexMcp {
  available: boolean;
  servers: { name: string; status: string }[];
  observedAt: string | null;
}

async function fetchCodexMcp(sessionId: string): Promise<AeRailCodexMcp> {
  const res = await authenticatedFetch(
    `/v1/sessions/${encodeURIComponent(sessionId)}/ae-mcp-status`,
  );
  if (res.status === 403) throw new Error("Connector status needs edit access to this session.");
  if (res.status === 404) {
    throw new Error("This server cannot report Codex connectors yet. Update OmniGent and retry.");
  }
  if (!res.ok) throw new Error(`Could not load connectors (HTTP ${res.status}). Try refresh.`);
  return (await res.json()) as AeRailCodexMcp;
}

/** Codex's last MCP startup map; refetched when a live startup event lands. */
export function useAeRailCodexMcp(sessionId: string, enabled: boolean) {
  const query = useQuery({
    queryKey: ["ae-rail-codex-mcp", sessionId],
    queryFn: () => fetchCodexMcp(sessionId),
    enabled: enabled && !isTempConvId(sessionId),
    retry: false,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
  });
  const live = useChatStore((s) => (s.conversationId === sessionId ? s.mcpStartup : null));
  const { refetch } = query;
  const seen = useRef(live);
  useEffect(() => {
    if (seen.current === live) return;
    seen.current = live;
    if (enabled) void refetch();
  }, [live, enabled, refetch]);
  return query;
}
