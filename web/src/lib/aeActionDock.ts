// The action dock's model: what waits on the user in this chat, most urgent
// first. Pure, so ordering, badges, hiding and the deploy lifecycle are
// unit-tested (aeActionDock.test.ts). omnigent-ae, 2026-10-20.

import { type AeLimitGate, aeLimitGateShort } from "@/lib/aeLimitGate";
import { type AePrDeploy, aeHasDeployState } from "@/lib/aePrDeploy";
import { type AePrCard, aeCiText, aeReadyToMerge } from "@/lib/aePrs";

export type AeDockKind = "question" | "limit" | "merge" | "draft" | "deploy";

/**
 * Urgency: a question blocks the agent, a usage limit is about to, a merge
 * waits on a click, a draft on a click before review, a deploy only on time.
 */
export const AE_DOCK_KINDS: readonly AeDockKind[] = [
  "question",
  "limit",
  "merge",
  "draft",
  "deploy",
];

/** A deploy item that went live stays this long, then clears. */
export const AE_DOCK_LIVE_MS = 60_000;

interface ItemBase {
  /** Unique across the dock. */
  key: string;
  /** Identifies the item for dismissal; a question's is its card's `data-ae-question`. */
  anchor: string;
  /** Age within its kind: lower is older. */
  order: number;
}

export interface AeDockQuestion extends ItemBase {
  kind: "question";
  text: string;
}

export interface AeDockMerge extends ItemBase {
  kind: "merge";
  url: string;
  repo: string;
  number: number;
  card: AePrCard;
}

/** An open draft pull request, waiting to be marked ready for review. */
export interface AeDockDraft extends ItemBase {
  kind: "draft";
  url: string;
  repo: string;
  number: number;
  card: AePrCard;
}

export interface AeDockDeploy extends ItemBase {
  kind: "deploy";
  url: string;
  repo: string;
  number: number;
  deploy: AePrDeploy;
  /** When this page saw it turn live; null while waiting. */
  liveAt: number | null;
}

/** The account's 5-hour or weekly window at or past the gate (aeLimitGate.ts). */
export interface AeDockLimit extends ItemBase {
  kind: "limit";
  gate: AeLimitGate;
  /** A fork onto another account is possible: a Claude session, another login, fork allowed. */
  canSwitchAccount: boolean;
}

export type AeDockItem = AeDockQuestion | AeDockLimit | AeDockMerge | AeDockDraft | AeDockDeploy;

/** "owner/repo#123", a pull request item's anchor. */
export function aeDockPrAnchor(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

export interface AeDockQuestionSource {
  id: string;
  message?: string | null;
  askUserQuestion?: Record<string, unknown> | null;
  codexCommand?: { command: string } | null;
}

/** One line for a pending question: the first AskUserQuestion, the command, or the prompt. */
export function aeDockQuestionText(source: AeDockQuestionSource): string {
  const questions = source.askUserQuestion?.questions;
  if (Array.isArray(questions)) {
    const first = questions[0] as { question?: unknown } | undefined;
    if (typeof first?.question === "string" && first.question.trim()) {
      return first.question.trim();
    }
  }
  if (source.codexCommand?.command) return `Run ${source.codexCommand.command}?`;
  const message = (source.message ?? "").trim().split("\n")[0];
  return message || "A question is waiting";
}

export function aeDockQuestions(sources: readonly AeDockQuestionSource[]): AeDockQuestion[] {
  return sources.map((source, order) => ({
    kind: "question",
    key: `question:${source.id}`,
    anchor: source.id,
    order,
    text: aeDockQuestionText(source),
  }));
}

export interface AeDockPr {
  url: string;
  repo: string;
  number: number;
  card?: AePrCard;
}

/** The transcript's pull requests that are ready to merge, first mentioned first. */
export function aeDockMerges(prs: readonly AeDockPr[]): AeDockMerge[] {
  const items: AeDockMerge[] = [];
  prs.forEach((pr, order) => {
    if (!pr.card || pr.card.draft || !aeReadyToMerge(pr.card)) return;
    const anchor = aeDockPrAnchor(pr.repo, pr.number);
    items.push({ kind: "merge", key: `merge:${anchor}`, anchor, order, ...pr, card: pr.card });
  });
  return items;
}

/** The transcript's open draft pull requests, first mentioned first. */
export function aeDockDrafts(prs: readonly AeDockPr[]): AeDockDraft[] {
  const items: AeDockDraft[] = [];
  prs.forEach((pr, order) => {
    if (pr.card?.state !== "open" || !pr.card.draft) return;
    const anchor = aeDockPrAnchor(pr.repo, pr.number);
    items.push({ kind: "draft", key: `draft:${anchor}`, anchor, order, ...pr, card: pr.card });
  });
  return items;
}

/**
 * What this page saw of each deploy: `waiting` once seen waiting, then the
 * time it turned live. A pull request first seen live went live before the
 * page looked, so it gets no item.
 */
export type AeDeployTrack = Record<string, { liveAt: number | null }>;

export function aeDeployTrack(
  previous: AeDeployTrack,
  deploys: ReadonlyMap<string, AePrDeploy>,
  now: number,
): AeDeployTrack {
  let next: AeDeployTrack | null = null;
  for (const [anchor, deploy] of deploys) {
    const seen = previous[anchor];
    if (deploy.state === "waiting" && !seen) {
      next ??= { ...previous };
      next[anchor] = { liveAt: null };
    } else if (deploy.state === "live" && seen && seen.liveAt === null) {
      next ??= { ...previous };
      next[anchor] = { liveAt: now };
    }
  }
  return next ?? previous;
}

/** Merged release-repo pull requests waiting for a deploy, or live under a minute. */
export function aeDockDeploys(
  prs: readonly AeDockPr[],
  deploys: ReadonlyMap<string, AePrDeploy>,
  track: AeDeployTrack,
  dismissed: ReadonlySet<string>,
  now: number,
): AeDockDeploy[] {
  const items: AeDockDeploy[] = [];
  prs.forEach((pr, order) => {
    if (pr.card?.state !== "merged" || !aeHasDeployState(pr.repo)) return;
    const anchor = aeDockPrAnchor(pr.repo, pr.number);
    const deploy = deploys.get(anchor);
    const seen = track[anchor];
    if (!deploy || !seen || dismissed.has(anchor)) return;
    if (deploy.state === "unknown") return;
    if (deploy.state === "live" && (seen.liveAt === null || now - seen.liveAt >= AE_DOCK_LIVE_MS)) {
      return;
    }
    items.push({
      kind: "deploy",
      key: `deploy:${anchor}`,
      anchor,
      order,
      url: pr.url,
      repo: pr.repo,
      number: pr.number,
      deploy,
      liveAt: deploy.state === "live" ? seen.liveAt : null,
    });
  });
  return items;
}

/**
 * Most urgent first, oldest first within a kind, minus questions whose card is
 * on screen (it floats just above the dock). Every other item stays, wherever
 * the feed is scrolled.
 */
export function aeDockArrange(
  items: readonly AeDockItem[],
  questionsOnScreen: ReadonlySet<string>,
): AeDockItem[] {
  const rank = (item: AeDockItem) => AE_DOCK_KINDS.indexOf(item.kind);
  return items
    .filter((item) => item.kind !== "question" || !questionsOnScreen.has(item.anchor))
    .sort((a, b) => rank(a) - rank(b) || a.order - b.order);
}

export interface AeDockBadge {
  kind: AeDockKind;
  count: number;
  label: string;
}

export interface AeDockSummary {
  lead: AeDockItem;
  /** Other items of the lead's kind ("+1 more"). */
  more: number;
  /** One badge per other kind present, in urgency order. */
  badges: AeDockBadge[];
  total: number;
}

export function aeDockSummary(
  items: readonly AeDockItem[],
  clock: (iso: string) => string = aeClock,
): AeDockSummary | null {
  const lead = items[0];
  if (!lead) return null;
  const badges: AeDockBadge[] = [];
  for (const kind of AE_DOCK_KINDS) {
    if (kind === lead.kind) continue;
    const ofKind = items.filter((item) => item.kind === kind);
    if (ofKind.length) {
      badges.push({ kind, count: ofKind.length, label: aeDockBadgeLabel(ofKind, clock) });
    }
  }
  const more = items.filter((item) => item.kind === lead.kind).length - 1;
  return { lead, more, badges, total: items.length };
}

/** "Question waiting", "2 questions", "#180 ready", "#181 draft", "#179 deploy 10:50 PM", "2 deploying". */
export function aeDockBadgeLabel(
  items: readonly AeDockItem[],
  clock: (iso: string) => string = aeClock,
): string {
  const first = items[0]!;
  const many = items.length > 1;
  switch (first.kind) {
    case "question":
      return many ? `${items.length} questions` : "Question waiting";
    case "limit":
      return aeLimitGateShort(first.gate);
    case "merge":
      return many ? `${items.length} to merge` : `#${first.number} ready`;
    case "draft":
      return many ? `${items.length} drafts` : `#${first.number} draft`;
    case "deploy": {
      if (many) {
        const live = items.every((item) => item.kind === "deploy" && item.deploy.state === "live");
        return `${items.length} ${live ? "live" : "deploying"}`;
      }
      if (first.deploy.state === "live") return `#${first.number} live`;
      if (first.deploy.hold_until)
        return `#${first.number} deploy ${clock(first.deploy.hold_until)}`;
      return `#${first.number} deploying`;
    }
  }
}

/** "just now", "4m ago", "2h ago", "3d ago". */
export function aeAgo(fromIso: string | null, now: number): string | null {
  if (!fromIso) return null;
  const then = Date.parse(fromIso);
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** "10:50 PM" in the viewer's clock. */
export function aeClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "you" for "you@example.com", as the Admin Center shows it. */
export function aeHolderName(setBy: string): string {
  const at = setBy.indexOf("@");
  return at > 0 ? setBy.slice(0, at) : setBy;
}

/**
 * What a deploy line says after the number: "merged 4m ago · deploy waits on
 * 2 busy sessions", "· held until 10:50 PM by reid", or "live in ae-v0.18.0.32".
 */
export function aeDeployText(
  item: AeDockDeploy,
  now: number,
  clock: (iso: string) => string = aeClock,
): string {
  const { deploy } = item;
  if (deploy.state === "live") return `live in ${deploy.running ?? "the running release"}`;
  const ago = aeAgo(deploy.merged_at, now);
  const merged = ago ? `merged ${ago}` : "merged";
  if (deploy.hold_until) {
    const by = deploy.hold_by ? ` by ${aeHolderName(deploy.hold_by)}` : "";
    return `${merged} · held until ${clock(deploy.hold_until)}${by}`;
  }
  if (deploy.mid_turn > 0) {
    const sessions = deploy.mid_turn === 1 ? "1 busy session" : `${deploy.mid_turn} busy sessions`;
    return `${merged} · deploy waits on ${sessions}`;
  }
  return `${merged} · waiting for deploy`;
}

/** The merge line's detail: "ready to merge · 5/5 checks". */
export function aeMergeText(item: AeDockMerge): string {
  return `ready to merge · ${aeCiText(item.card.ci)}`;
}

/** The draft line's detail: "draft · 5/5 checks". */
export function aeDraftText(item: AeDockDraft): string {
  return `draft · ${aeCiText(item.card.ci)}`;
}

/** The dock's header and accessible name: "3 waiting". */
export function aeDockCountText(total: number): string {
  return `${total} waiting`;
}
