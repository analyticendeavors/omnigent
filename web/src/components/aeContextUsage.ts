import { useEffect, useState } from "react";
import { authenticatedFetch } from "@/lib/identity";

export interface ContextCategory {
  name: string;
  tokens: number;
  kind: "used" | "free" | "buffer" | "deferred";
}
export interface ContextUsage {
  available: boolean;
  reason?: string;
  categories: ContextCategory[];
  totalTokens: number;
  maxTokens: number;
  autoCompactThreshold: number | null;
  isAutoCompactEnabled: boolean;
  observedAt: string;
  complete: boolean;
  details: Record<string, { name: string; tokens: number }[]>;
}

export function useContextUsage(session: string | null, enabled: boolean, identity: string) {
  const [state, setState] = useState<{ key: string; data?: ContextUsage; error?: string }>({
    key: "",
  });
  const key = `${session}:${identity}`;
  useEffect(() => {
    if (!enabled || !session) return;
    let cancelled = false;
    setState({ key });
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      return authenticatedFetch(`/v1/sessions/${encodeURIComponent(session)}/context-usage`)
        .then(async (response) => {
          if (!response.ok)
            throw new Error("Could not load context. Close and reopen the breakdown to retry.");
          return (await response.json()) as ContextUsage;
        })
        .then((data) => {
          if (!cancelled) setState({ key, data });
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setState({
              key,
              error: error instanceof Error ? error.message : "Context unavailable",
            });
        })
        .finally(() => {
          inFlight = false;
        });
    };
    void refresh();
    const timer = setInterval(refresh, 180_000);
    return () => {
      clearInterval(timer);
      cancelled = true;
    };
  }, [enabled, session, key]);
  return enabled && state.key === key ? state : { key };
}

export const categoryColors = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
  "bg-sky-500",
  "bg-violet-500",
  "bg-teal-500",
];
export function categoryColor(name: string) {
  const names = [
    "System prompt",
    "System tools",
    "MCP server instructions",
    "MCP tools",
    "Custom agents",
    "Memory files",
    "Skills",
    "Messages",
  ];
  return categoryColors[Math.max(0, names.indexOf(name)) % categoryColors.length];
}

export function contextCountdown(data: ContextUsage, used: number): string | null {
  if (!data.isAutoCompactEnabled) return "Auto-compact is off";
  if (data.autoCompactThreshold == null) return null;
  const left = data.autoCompactThreshold - used;
  return left <= 0 ? "Auto-compact is due" : `About ${Math.round(left / 1000)}k until auto-compact`;
}
