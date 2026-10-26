// The Codex model list for Settings > Roles (omnigent-ae, 2026-10-26): the
// reviewer rows list its latest models and the update chips compare against all
// of it. Read from the host the agents come from, once; the rows and the editor
// share one query.

import type { AeReviewerAgents } from "@/hooks/useAeReviewerAgents";
import { useHostModelOptions } from "@/hooks/useHosts";
import { aeIsCodexAgent } from "@/lib/aeReviewers";
import type { AeTeamOption } from "@/lib/aeTeamOptions";
import type { NativeModelOption } from "@/lib/types";

export interface AeCodexCatalog {
  /** The Codex agent the reviewer rows can run, ready or not; null when none is listed. */
  option: AeTeamOption | null;
  /** The agent is ready on an online host, so its models can be listed and picked. */
  ready: boolean;
  rows: readonly NativeModelOption[];
  loading: boolean;
  failed: boolean;
}

const NO_ROWS: readonly NativeModelOption[] = [];

export function useAeCodexCatalog({ options, host }: AeReviewerAgents): AeCodexCatalog {
  const codex = options.filter((o) => aeIsCodexAgent(o.agent));
  const option = codex.find((o) => o.readiness.selectable && o.primary) ?? codex[0] ?? null;
  const ready = !!option?.readiness.selectable && host?.status === "online";
  const catalog = useHostModelOptions(host?.host_id ?? null, option?.agent.harness ?? "", ready, {
    poll: false,
  });
  return {
    option,
    ready,
    rows: catalog.data ?? NO_ROWS,
    loading: ready && !catalog.data && !catalog.isError,
    failed: ready && !!catalog.isError && !catalog.data,
  };
}
