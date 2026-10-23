// The host's Claude models for the role table (Settings > Roles and the
// session's Customize rows): one row per catalog id, labeled "Opus 5.5".

import { useMemo } from "react";
import { useHostModelOptions, useHosts } from "@/hooks/useHosts";
import { aeWithClaudeVersions } from "@/lib/aeClaudeModels";
import { aeModelLabel } from "@/lib/aeRoles";

/** The Claude catalog the role table offers. */
const CLAUDE_HARNESS = "claude-native";

export interface AeRoleModelChoice {
  /** The catalog id saved in the preset, e.g. `claude-opus-5-5`. */
  value: string;
  label: string;
}

export function useAeRoleModels(): {
  models: AeRoleModelChoice[];
  ids: string[];
  note: string | null;
} {
  const hostsQuery = useHosts();
  const hosts = hostsQuery.data ?? [];
  const hostsLoaded = hostsQuery.isSuccess === true;
  const online = hosts.filter((h) => h.status === "online");
  const host =
    online.find((h) => h.configured_harnesses?.[CLAUDE_HARNESS] === true) ?? online[0] ?? null;
  const catalog = useHostModelOptions(host?.host_id ?? null, CLAUDE_HARNESS, true, { poll: false });
  return useMemo(() => {
    const seen = new Set<string>();
    const models: AeRoleModelChoice[] = [];
    for (const row of aeWithClaudeVersions(catalog.data ?? [])) {
      const value = (row.model ?? row.id).replace(/\[[^\]]*\]$/, "");
      if (seen.has(value)) continue;
      seen.add(value);
      models.push({ value, label: aeModelLabel(value) });
    }
    const note = !hostsLoaded
      ? null
      : !host
        ? "No host is online, so only the models already in this preset are listed."
        : catalog.isError
          ? "The model list is unavailable right now; the models already in this preset still save."
          : null;
    return { models, ids: models.map((m) => m.value), note };
  }, [catalog.data, catalog.isError, host, hostsLoaded]);
}
