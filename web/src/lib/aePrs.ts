// The PR cards' data: one card per pull request the session tracks, read from
// omnigent-ae's `GET /v1/ae/prs/{owner}/{repo}/{n}` and merged through
// `POST .../merge` (packages/ae_omni_policies/src/ae_omni_policies/prs.py). The
// server decides whether Merge is live and why not, so this card and the
// Dashboard's Open PRs card never disagree. omnigent-ae patch P11, 2026-09-24.

import { authenticatedFetch } from "@/lib/identity";

export type AePrCiState = "passing" | "failing" | "pending" | "none" | "unknown";
export type AePrMergeableState =
  | "clean"
  | "unstable"
  | "conflicted"
  | "blocked"
  | "behind"
  | "draft"
  | "checking"
  | "merged"
  | "closed";
export type AePrReviewState =
  "approved" | "changes_requested" | "review_required" | "none" | "unknown";
export type AeMergeMethod = "squash" | "merge";

export interface AePrCard {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  author: string | null;
  head_ref: string | null;
  base_ref: string | null;
  head_sha: string | null;
  ci: { state: AePrCiState; passing: number; failing: number; pending: number; total: number };
  mergeable: { state: AePrMergeableState; detail: string };
  review: {
    state: AePrReviewState;
    approvals: number;
    changes_requested: number;
    requested: string[];
  };
  merge: {
    methods: AeMergeMethod[];
    default_method: AeMergeMethod | null;
    allowed: boolean;
    reason: string | null;
  };
}

export interface AeMergeResult {
  merged: true;
  repo: string;
  number: number;
  method: AeMergeMethod;
  sha: string | null;
  message: string;
  session: { id: string; status: string | null; offer_review: boolean } | null;
}

/** A non-2xx answer, with omnigent-ae's `{"error": {"code", "message", "card"?}}` read out. */
export class AePrError extends Error {
  readonly status: number;
  readonly code: string;
  readonly card: AePrCard | null;

  constructor(status: number, body: unknown) {
    const error =
      body && typeof body === "object" ? (body as { error?: Record<string, unknown> }).error : null;
    const message =
      typeof error?.message === "string" ? error.message : `Request failed (${status})`;
    super(message);
    this.name = "AePrError";
    this.status = status;
    this.code = typeof error?.code === "string" ? error.code : "http_error";
    this.card = error?.card && typeof error.card === "object" ? (error.card as AePrCard) : null;
  }
}

/** The server has no GitHub token: the cards say so once and stay out of the way. */
export const AE_PR_NOT_CONFIGURED = "github_not_configured";

const PULL =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/;

/** `owner/repo` and the number of a github.com pull request URL, else null. */
export function parseAePrUrl(url: string): { repo: string; number: number } | null {
  const match = PULL.exec(url.trim());
  if (!match || [match[1], match[2]].some((part) => /^\.+$/.test(part))) return null;
  return { repo: `${match[1]}/${match[2]}`.toLowerCase(), number: Number(match[3]) };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchAePrCard(
  repo: string,
  number: number,
  fresh = false,
): Promise<AePrCard> {
  const res = await authenticatedFetch(
    `/v1/ae/prs/${repo}/${number}${fresh ? "?fresh=true" : ""}`,
    { method: "GET" },
  );
  const body = await readJson(res);
  if (!res.ok) throw new AePrError(res.status, body);
  return body as AePrCard;
}

/** Merge pinned to the head SHA the card showed; a refusal carries the fresh card. */
export async function mergeAePr(
  card: Pick<AePrCard, "repo" | "number" | "head_sha">,
  method: AeMergeMethod,
  sessionId?: string,
): Promise<AeMergeResult> {
  const res = await authenticatedFetch(`/v1/ae/prs/${card.repo}/${card.number}/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sha: card.head_sha,
      method,
      ...(sessionId ? { session_id: sessionId } : {}),
    }),
  });
  const body = await readJson(res);
  if (!res.ok) throw new AePrError(res.status, body);
  return body as AeMergeResult;
}

/** "CI 6/6 passing", "CI 1 failing of 6", "CI 2 running of 6", "no checks". */
export function aeCiText(ci: AePrCard["ci"]): string {
  switch (ci.state) {
    case "passing":
      return `CI ${ci.passing}/${ci.total} passing`;
    case "failing":
      return `CI ${ci.failing} failing of ${ci.total}`;
    case "pending":
      return `CI ${ci.pending} running of ${ci.total}`;
    case "none":
      return "no checks";
    default:
      return "CI unknown";
  }
}

export const AE_MERGEABLE_TEXT: Record<AePrMergeableState, string> = {
  clean: "no conflicts",
  unstable: "mergeable",
  conflicted: "conflicted",
  blocked: "blocked",
  behind: "behind base",
  draft: "draft",
  checking: "checking",
  merged: "merged",
  closed: "closed",
};

export const AE_REVIEW_TEXT: Record<AePrReviewState, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  review_required: "review requested",
  none: "no review",
  unknown: "reviews unknown",
};

export const AE_METHOD_TEXT: Record<AeMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge commit",
};

const PULL_IN_TEXT =
  /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*(?![0-9])/g;

/** Every distinct github.com pull request URL in `text`, in order. */
export function aePrUrlsIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(PULL_IN_TEXT)) {
    if (parseAePrUrl(match[0])) seen.add(match[0]);
  }
  return [...seen];
}
