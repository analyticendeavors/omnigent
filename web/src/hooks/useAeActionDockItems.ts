// The action dock's data. Pull requests come from the whole transcript through
// the inline cards' own query keys and fetchers, so the dock and the cards
// agree; pending questions are the ones the transcript floats to the bottom,
// published by Transcript.tsx. omnigent-ae, 2026-10-20.

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AE_PR_POLL_MS } from "@/components/AePrCards";
import { useAeLimitGate } from "@/hooks/useAeLimitGate";
import { fetchPullRequestInfo } from "@/hooks/usePullRequests";
import {
  type AeDeployTrack,
  type AeDockItem,
  type AeDockPr,
  type AeDockQuestionSource,
  AE_DOCK_LIVE_MS,
  aeDeployTrack,
  type AeBranchUpdate,
  aeBranchUpdatePending,
  aeDockArrange,
  aeDockDeploys,
  aeDockDrafts,
  aeDockWaiting,
  aeDockMerges,
  aeDockPrAnchor,
  aeDockQuestions,
} from "@/lib/aeActionDock";
import { type AePrDeploy, aeHasDeployState, aePrDeployQuery } from "@/lib/aePrDeploy";
import { type AePrCard, aePrUrlsIn, fetchAePrCard, parseAePrUrl } from "@/lib/aePrs";
import type { AnyBlock } from "@/lib/blocks";
import { useChatStore } from "@/store/chatStore";

// ── pending questions, published by the transcript ─────────────────────

// By session, so split panes each keep their own.
const NONE: AeDockQuestionSource[] = [];
let published: ReadonlyMap<string, AeDockQuestionSource[]> = new Map();
const listeners = new Set<() => void>();

function publish(conversationId: string, questions: AeDockQuestionSource[] | null) {
  const next = new Map(published);
  if (questions?.length) next.set(conversationId, questions);
  else if (!next.delete(conversationId)) return;
  published = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Transcript.tsx hands the dock the questions it renders at the bottom. */
export function useAePublishDockQuestions(
  conversationId: string | null,
  pending: readonly {
    elicitationId: string;
    message?: string;
    askUserQuestion?: Record<string, unknown> | null;
    codexCommand?: { command: string } | null;
  }[],
  codex: readonly { itemId: string; questions: readonly { title: string }[] }[],
) {
  useEffect(() => {
    if (!conversationId) return;
    publish(conversationId, [
      ...pending.map((item) => ({
        id: item.elicitationId,
        message: item.message,
        askUserQuestion: item.askUserQuestion,
        codexCommand: item.codexCommand,
      })),
      ...codex.map(({ itemId, questions: asked }) => ({
        id: itemId,
        message: asked[0]?.title ?? null,
      })),
    ]);
    return () => publish(conversationId, null);
  }, [conversationId, pending, codex]);
}

function useDockQuestions(conversationId: string | undefined) {
  const current = useSyncExternalStore(subscribe, () => published);
  return (conversationId && current.get(conversationId)) || NONE;
}

// ── pull requests in the transcript ────────────────────────────────────

const urlsOfBlock = new WeakMap<AnyBlock, string[]>();

/** Every pull request URL in the transcript's finished replies, first mention first. */
export function aePrUrlsInBlocks(blocks: readonly AnyBlock[]): string[] {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "text_done") continue;
    let urls = urlsOfBlock.get(block);
    if (!urls) {
      urls = aePrUrlsIn(block.fullText ?? "");
      urlsOfBlock.set(block, urls);
    }
    for (const url of urls) seen.add(url);
  }
  return [...seen];
}

// ── deploys this page saw waiting, kept across a reload ────────────────

function trackKey(sessionId: string) {
  return `ae-action-dock:deploys:${sessionId}`;
}

/**
 * A waiting deploy remembered longer than this is dropped on load: a deploy
 * holds at most three hours, so a "live" seen after that is old news.
 */
const TRACK_KEEP_MS = 4 * 3600_000;

/** Stored as `[[anchor, seen waiting at ms], ...]`. */
function loadTrack(sessionId: string | undefined, now: number): AeDeployTrack {
  if (!sessionId) return {};
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(trackKey(sessionId)) ?? "[]");
    if (!Array.isArray(raw)) return {};
    const fresh = raw.filter(
      (entry): entry is [string, number] =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "number" &&
        now - entry[1] < TRACK_KEEP_MS,
    );
    return Object.fromEntries(fresh.map(([anchor]) => [anchor, { liveAt: null }]));
  } catch {
    return {};
  }
}

function saveTrack(sessionId: string | undefined, track: AeDeployTrack, now: number) {
  if (!sessionId) return;
  try {
    const key = trackKey(sessionId);
    const before = new Map<string, number>(JSON.parse(window.localStorage.getItem(key) ?? "[]"));
    const waiting = Object.entries(track)
      .filter(([, seen]) => seen.liveAt === null)
      .map(([anchor]) => [anchor, before.get(anchor) ?? now] as const);
    if (waiting.length) window.localStorage.setItem(key, JSON.stringify(waiting));
    else window.localStorage.removeItem(key);
  } catch {
    // Storage off or unreadable: a reload mid-deploy only loses the minute-long live line.
  }
}

/** Deploy lines dismissed on this page (x), until it reloads. */
const dismissedDeploys = new Set<string>();

// ── the hook ───────────────────────────────────────────────────────────

/**
 * The dock's items, arranged, minus questions whose card is on screen
 * (`questionsOnScreen` holds `data-ae-question` values).
 */
export function useAeActionDockItems(
  sessionId: string | undefined,
  questionsOnScreen: ReadonlySet<string>,
): { items: AeDockItem[]; dismiss: (anchor: string) => void } {
  const joined = useChatStore((s) =>
    s.conversationId === sessionId ? aePrUrlsInBlocks(s.blocks).join("\n") : "",
  );
  // The panel's tracked list, read only (never fetched from here), as the inline cards do.
  const info = useQuery({
    queryKey: ["github-info", sessionId],
    queryFn: () => fetchPullRequestInfo(sessionId!),
    enabled: false,
  });
  const tracked = info.data?.prs;
  const prs = useMemo(() => {
    // Only the session's own pull requests: a link merely quoted (another
    // session's, in a handoff) must never offer Merge. Unknown list, no items.
    if (!tracked || !joined) return [];
    const keep = new Set(tracked.map((pr) => pr.url.toLowerCase()));
    const seen = new Set<string>();
    const out: { url: string; repo: string; number: number }[] = [];
    for (const url of joined.split("\n")) {
      const parsed = parseAePrUrl(url);
      if (!parsed || !keep.has(url.toLowerCase())) continue;
      const anchor = aeDockPrAnchor(parsed.repo, parsed.number);
      if (seen.has(anchor)) continue;
      seen.add(anchor);
      out.push({ url, ...parsed });
    }
    return out;
  }, [joined, tracked]);
  // The cards' own query. It polls only while no card in the feed polls it,
  // fresh and every 2 s while an Update branch from the dock waits on the new head.
  const queryClient = useQueryClient();
  const updatePending = (repo: string, number: number, head: string | null) =>
    aeBranchUpdatePending(
      queryClient.getQueryData<AeBranchUpdate>(["ae-pr-branch-update", repo, number]),
      head,
      Date.now(),
    );
  const cards = useQueries({
    queries: prs.map(({ repo, number }) => ({
      queryKey: ["ae-pr", repo, number] as const,
      queryFn: () =>
        fetchAePrCard(
          repo,
          number,
          updatePending(
            repo,
            number,
            queryClient.getQueryData<AePrCard>(["ae-pr", repo, number])?.head_sha ?? null,
          ),
        ),
      retry: false,
      refetchInterval: (query: { state: { data?: AePrCard }; getObserversCount: () => number }) =>
        (query.state.data && query.state.data.state !== "open") || query.getObserversCount() > 1
          ? false
          : updatePending(repo, number, query.state.data?.head_sha ?? null)
            ? 2_000
            : AE_PR_POLL_MS,
    })),
  });
  const withCards: AeDockPr[] = prs.map((pr, i) => ({ ...pr, card: cards[i]?.data }));
  const mergedRelease = withCards.filter(
    (pr) => pr.card?.state === "merged" && aeHasDeployState(pr.repo),
  );
  const deployResults = useQueries({
    queries: mergedRelease.map(({ repo, number }) =>
      aePrDeployQuery(repo, number, !dismissedDeploys.has(aeDockPrAnchor(repo, number))),
    ),
  });
  const deploys = new Map<string, AePrDeploy>();
  mergedRelease.forEach((pr, i) => {
    const data = deployResults[i]?.data;
    if (data) deploys.set(aeDockPrAnchor(pr.repo, pr.number), data);
  });
  const deploysKey = [...deploys].map(([anchor, d]) => `${anchor}:${d.state}`).join(",");

  const [track, setTrack] = useState<AeDeployTrack>(() => loadTrack(sessionId, Date.now()));
  const [now, setNow] = useState(() => Date.now());
  const [, setDismissals] = useState(0);
  const deploysRef = useRef(deploys);
  deploysRef.current = deploys;
  useEffect(() => {
    const at = Date.now();
    setNow(at);
    setTrack((previous) => {
      const next = aeDeployTrack(previous, deploysRef.current, at);
      if (next !== previous) saveTrack(sessionId, next, at);
      return next;
    });
  }, [deploysKey, sessionId]);
  // Re-read the clock each minute ("merged 4m ago") and when a live line ends.
  useEffect(() => {
    const pending = Object.values(track)
      .map((seen) => (seen.liveAt === null ? null : seen.liveAt + AE_DOCK_LIVE_MS - Date.now()))
      .filter((ms): ms is number => ms !== null && ms > 0);
    const wait = Math.min(60_000, ...pending);
    const timer = window.setTimeout(() => setNow(Date.now()), wait + 50);
    return () => window.clearTimeout(timer);
  }, [track, now]);

  const questions = useDockQuestions(sessionId);
  const limit = useAeLimitGate(sessionId);
  const items = aeDockArrange(
    [
      ...aeDockQuestions(questions),
      ...(limit.item ? [limit.item] : []),
      ...aeDockMerges(withCards),
      ...aeDockDrafts(withCards),
      ...aeDockWaiting(withCards),
      ...aeDockDeploys(withCards, deploys, track, dismissedDeploys, now),
    ],
    questionsOnScreen,
  );
  return {
    items,
    dismiss: (anchor) => {
      if (anchor === limit.item?.anchor) return limit.dismiss();
      dismissedDeploys.add(anchor);
      setDismissals((n) => n + 1);
    },
  };
}

// ── question cards on screen ───────────────────────────────────────────

const ANCHORS = "[data-ae-question]";

function anchorOf(el: Element): string | null {
  return el.getAttribute("data-ae-question");
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

/**
 * The `data-ae-question` values of question cards now on screen. The feed is
 * virtualized, so a mutation observer picks up cards as they mount.
 */
export function useAeQuestionsOnScreen(): ReadonlySet<string> {
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<Element, string>();
    const observed = new Set<Element>();
    const update = () =>
      setOnScreen((previous) => {
        const next = new Set(visible.values());
        return sameSet(previous, next) ? previous : next;
      });
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const anchor = anchorOf(entry.target);
        if (entry.isIntersecting && anchor) visible.set(entry.target, anchor);
        else visible.delete(entry.target);
      }
      update();
    });
    let frame = 0;
    const scan = () => {
      frame = 0;
      const present = new Set(document.querySelectorAll(ANCHORS));
      for (const el of present) {
        if (!observed.has(el)) {
          observed.add(el);
          io.observe(el);
        }
      }
      for (const el of observed) {
        if (!present.has(el)) {
          observed.delete(el);
          io.unobserve(el);
          visible.delete(el);
        }
      }
      update();
    };
    // Rescan only when a card may have come or gone, not on every streamed token.
    const touchesCard = (node: Node) =>
      node instanceof Element && (node.matches(ANCHORS) || node.querySelector(ANCHORS) !== null);
    const mo = new MutationObserver((records) => {
      if (frame) return;
      const relevant = records.some(
        (record) =>
          [...record.addedNodes].some(touchesCard) || [...record.removedNodes].some(touchesCard),
      );
      if (relevant) frame = window.requestAnimationFrame(scan);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    scan();
    return () => {
      mo.disconnect();
      io.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, []);
  return onScreen;
}
