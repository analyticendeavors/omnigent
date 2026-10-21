// The merged row's deploy status for omnigent-ae pull requests: purple
// "waiting for deploy" until the running release contains the merge, then green
// "live in ae-vX". Other repos show nothing. Reads the action dock's own query
// (aePrDeploy.ts), so the row and the dock agree. omnigent-ae, 2026-10-20.

import { useQueries } from "@tanstack/react-query";
import { MERGED_TEXT } from "@/components/AePrCards";
import { AE_ICON_ROCKET } from "@/lib/aeActionDockIcons";
import { AE_ICON_CHECK } from "@/lib/aePrIcons";
import { aeHasDeployState, aePrDeployQuery } from "@/lib/aePrDeploy";
import type { AePrCard } from "@/lib/aePrs";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import { cn } from "@/lib/utils";

export function AePrDeployStatus({
  prs,
}: {
  prs: readonly { repo: string; number: number; card: AePrCard }[];
}) {
  const merged = prs.filter((pr) => pr.card.state === "merged" && aeHasDeployState(pr.repo));
  const results = useQueries({
    queries: merged.map((pr) => aePrDeployQuery(pr.repo, pr.number)),
  });
  const states = results.map((result) => result.data);
  const waiting = states.some((data) => data?.state === "waiting");
  const live = states.length > 0 && states.every((data) => data?.state === "live");
  if (!waiting && !live) return null;
  return (
    <span
      data-testid="ae-pr-deploy-status"
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs",
        waiting ? MERGED_TEXT : "text-emerald-600 dark:text-emerald-400",
      )}
    >
      <AeTablerSvg node={waiting ? AE_ICON_ROCKET : AE_ICON_CHECK} className="size-3.5" />
      {waiting ? "waiting for deploy" : `live in ${states[0]!.running}`}
    </span>
  );
}
