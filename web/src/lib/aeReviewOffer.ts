// Whether a PR card offers "Set this session to review" after a merge.
// Review means the session is done and frees one of Reid's three slots, so the
// offer belongs after the merge of the session's last open tracked pull
// request, not after the first of several. On 2026-09-25 a session that had
// opened four pull requests offered review after the first merge while three
// were still open. The rule: count the session's other tracked pull requests
// (upstream's per-session list, the one the GitHub panel reads) whose card
// still says open; offer review at zero, say how many are left otherwise, and
// say nothing while a state is still unknown. omnigent-ae patch P20.

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchGithubInfo } from "@/hooks/useGithub";
import { type AePrCard, fetchAePrCard, parseAePrUrl } from "@/lib/aePrs";

export type AeReviewOffer =
  { kind: "offer" } | { kind: "open"; count: number } | { kind: "unknown" };

interface PrRef {
  repo: string;
  number: number;
}

/**
 * The github.com pull requests in `tracked` other than `merged`, once each.
 * A tracked URL on another host has no card and is left out.
 */
export function aeOtherTrackedPrs(tracked: readonly { url: string }[], merged: PrRef): PrRef[] {
  const self = `${merged.repo.toLowerCase()}#${merged.number}`;
  const seen = new Set([self]);
  const out: PrRef[] = [];
  for (const pr of tracked) {
    const parsed = parseAePrUrl(pr.url);
    if (!parsed) continue;
    const key = `${parsed.repo}#${parsed.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

/**
 * The decision, from the states of the session's other tracked pull requests
 * (`undefined` for one not read yet or unreadable; the whole list `undefined`
 * while the tracked list itself is unknown). Any open one holds the offer back
 * and is counted; an unknown one also holds it back, silently, so a slow or
 * failed read never offers review early.
 */
export function aeReviewOffer(
  others: readonly (AePrCard["state"] | undefined)[] | undefined,
): AeReviewOffer {
  if (!others) return { kind: "unknown" };
  const count = others.filter((state) => state === "open").length;
  if (count > 0) return { kind: "open", count };
  if (others.some((state) => state === undefined)) return { kind: "unknown" };
  return { kind: "offer" };
}

/** "1 more open pull request in this session", "3 more open pull requests in this session". */
export function aeMoreOpenText(count: number): string {
  return `${count} more open pull request${count === 1 ? "" : "s"} in this session`;
}

/**
 * The offer for the card that just merged `merged`. `tracked` is the session's
 * list when the caller holds it (the GitHub panel does); otherwise it is read
 * from the session's GitHub info, once, after the merge. The other cards'
 * states come from the same `["ae-pr", repo, number]` queries the cards use,
 * so the panel's cards are not read twice.
 */
export function useAeReviewOffer(
  sessionId: string | undefined,
  merged: PrRef,
  tracked: readonly { url: string }[] | undefined,
): AeReviewOffer {
  const info = useQuery({
    queryKey: ["github-info", sessionId],
    queryFn: () => fetchGithubInfo(sessionId!),
    enabled: !!sessionId && !tracked,
  });
  const others = useMemo(() => {
    const list = tracked ?? (info.data ? (info.data.prs ?? []) : undefined);
    return list ? aeOtherTrackedPrs(list, merged) : undefined;
  }, [tracked, info.data, merged]);
  const cards = useQueries({
    queries: (others ?? []).map((ref) => ({
      queryKey: ["ae-pr", ref.repo, ref.number],
      queryFn: () => fetchAePrCard(ref.repo, ref.number),
      retry: false,
    })),
  });
  return aeReviewOffer(others && cards.map((query) => query.data?.state));
}
