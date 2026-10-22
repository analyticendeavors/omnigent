// The PR receipt: the one line a chat message keeps for a pull request it names
// (AePrCards.tsx, variant "inline"). It records the pull request and never acts;
// the action dock owns Merge. One function maps the card and the deploy state to
// the status word, its tone and the icon, so the icon and the word always agree.
//
// Precedence, first match wins: merged (live, or merged with its time), closed,
// then for an open pull request: draft, conflicts, failed checks, changes
// requested, checks running, behind the base with Update branch live, ready,
// and a waiting word for the rest (behind, checking conflicts, review
// requested, checks unknown, blocked, mergeable).
// "live" names no release: the server cannot tell which one first shipped it.
// omnigent-ae, 2026-10-21.

import { type AePrDeploy, aeHasDeployState } from "@/lib/aePrDeploy";
import { type AePrCard, aeReadyToMerge } from "@/lib/aePrs";

/**
 * gray: not in play (draft, closed); amber: waiting on checks or a person;
 * red: a problem; blue: behind the base (one click on Update branch); green:
 * ready; purple: merged, deploy to come; done: finished (the word steps back).
 */
export type AeReceiptTone = "gray" | "amber" | "red" | "blue" | "green" | "purple" | "done";

/** ring: an outlined circle; dashed: a draft's broken ring; filled: a solid circle with a check. */
export type AeReceiptIcon = "ring" | "dashed" | "filled";

export interface AePrReceipt {
  word: string;
  tone: AeReceiptTone;
  icon: AeReceiptIcon;
  /** A closed pull request's title steps back too. */
  dim: boolean;
}

/** "03:35" in local time, or null for a missing or unreadable time. */
export function aeReceiptClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const receipt = (word: string, tone: AeReceiptTone, icon: AeReceiptIcon = "ring") => ({
  word,
  tone,
  icon,
  dim: false,
});

function checks(ci: AePrCard["ci"]): string {
  return `checks ${ci.passing}/${ci.total}`;
}

function failed(ci: AePrCard["ci"]): string {
  return `${ci.failing} ${ci.failing === 1 ? "check" : "checks"} failed`;
}

function waitingWord(card: AePrCard): string {
  if (card.mergeable.state === "behind") return `behind ${card.base_ref ?? "base"}`;
  if (card.mergeable.state === "checking") return "checking conflicts";
  if (card.review.state === "review_required") return "review requested";
  if (card.ci.state === "unknown") return "checks unknown";
  if (card.mergeable.state === "blocked") return "blocked";
  // Allowed but not clean (GitHub's "unstable"): only the panel merges it.
  if (card.merge.allowed) return "mergeable";
  return "not ready";
}

/**
 * The receipt for `card`. `deploy` is the release repo's deploy state, when
 * read; `mergedHere` is a merge this page made that GitHub has not echoed yet.
 */
export function aePrReceipt(
  card: AePrCard,
  { deploy, mergedHere = false }: { deploy?: AePrDeploy | null; mergedHere?: boolean } = {},
): AePrReceipt {
  if (mergedHere || card.state === "merged") {
    const clock = aeReceiptClock(card.merged_at ?? deploy?.merged_at);
    const merged = clock ? `merged ${clock}` : "merged";
    // Outside the release repo the merge is the end of the story.
    if (!aeHasDeployState(card.repo)) return receipt(merged, "done", "filled");
    if (deploy?.state === "live") return receipt("live", "done", "filled");
    return receipt(merged, "purple");
  }
  if (card.state === "closed") return { ...receipt("closed", "gray"), dim: true };
  const { ci } = card;
  if (card.draft) {
    const detail = ci.state === "failing" ? failed(ci) : ci.total > 0 ? checks(ci) : null;
    return receipt(detail ? `draft · ${detail}` : "draft", "gray", "dashed");
  }
  if (card.mergeable.state === "conflicted") return receipt("conflicts", "red");
  if (ci.state === "failing") {
    return receipt(failed(ci), "red");
  }
  if (card.review.state === "changes_requested") return receipt("changes requested", "amber");
  if (ci.state === "pending") return receipt(checks(ci), "amber");
  // Blue only when Update branch is live; a refused update waits like the rest.
  if (card.update_branch?.allowed) {
    return receipt(`behind ${card.base_ref ?? "base"} · update branch`, "blue");
  }
  if (aeReadyToMerge(card)) return receipt("ready", "green");
  return receipt(waitingWord(card), "amber");
}

/**
 * The receipt's pointer to where the pull request is acted on: the dock lists
 * drafts and pull requests ready to merge; one GitHub allows but does not call
 * clean merges only from the panel.
 */
export function aeReceiptHint(card: AePrCard): string | null {
  if (card.state !== "open") return null;
  if (card.draft) return "Mark ready from the action bar";
  if (aeReadyToMerge(card)) return "Merge from the action bar";
  if (card.merge.allowed) return "Merge from the GitHub panel";
  return "Merge shows in the action bar once ready";
}
