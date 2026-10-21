// Whether a merged omnigent-ae pull request runs on the box yet, from
// omnigent-ae's `GET /v1/ae/prs/{owner}/{repo}/{n}/deploy`
// (packages/ae_omni_policies/src/ae_omni_policies/pr_deploy.py). The action
// dock's deploy line and the feed's merged row read the same query, so they
// never disagree. omnigent-ae, 2026-10-20.

import { authenticatedFetch } from "@/lib/identity";

export interface AePrDeploy {
  /** `unknown`: GitHub off or failing, or no running tag; no deploy item then. */
  state: "waiting" | "live" | "unknown";
  running: string | null;
  latest: string | null;
  /** Sessions mid-turn, which the box's auto-update waits on. */
  mid_turn: number;
  hold_until: string | null;
  hold_by: string | null;
  merged_at: string | null;
  error: string | null;
}

/** Only pull requests in the release repo get a deploy state. */
export const AE_RELEASE_REPO = "analyticendeavors/omnigent-ae";

/** The Admin Center, where the deploy hold is set and lifted. */
export const AE_ADMIN_CENTER_PATH = "/extensions/analyticendeavors.parking-lot/fabric";

/** How often a waiting pull request asks again. */
export const AE_DEPLOY_POLL_MS = 60_000;

export function aeHasDeployState(repo: string): boolean {
  return repo.toLowerCase() === AE_RELEASE_REPO;
}

export async function fetchAePrDeploy(repo: string, number: number): Promise<AePrDeploy> {
  const res = await authenticatedFetch(`/v1/ae/prs/${repo}/${number}/deploy`, { method: "GET" });
  if (!res.ok) throw new Error(`Deploy state failed (${res.status})`);
  const body = (await res.json()) as AePrDeploy;
  // An answer of another shape (an older server) claims nothing.
  return body.state === "waiting" || body.state === "live" ? body : { ...body, state: "unknown" };
}

/**
 * The one query both readers use: polled every 60 s while waiting, never
 * again once live (a release does not lose a commit) or unknown.
 */
export function aePrDeployQuery(repo: string, number: number, enabled = true) {
  return {
    queryKey: ["ae-pr-deploy", repo, number] as const,
    queryFn: () => fetchAePrDeploy(repo, number),
    enabled,
    retry: false,
    refetchInterval: (query: { state: { data?: AePrDeploy } }) =>
      query.state.data?.state === "waiting" ? AE_DEPLOY_POLL_MS : false,
  };
}
