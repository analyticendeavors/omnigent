// A plain-English line for an approval card whose summary no agent wrote (omnigent-ae,
// 2026-11-27). `POST /v1/ae/approval-summary` has Haiku rewrite the derived line, and the card
// shows the answer above it. Fires once per distinct card body, only for source "derived" or
// "generic" (the agent's own words never call the model), and fails quiet: a 503, a timeout or
// a missing service leaves today's card.

import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalSummary } from "@/lib/aeApprovalSummary";
import { scrub } from "@/lib/aeApprovalSummaryTools";
import { authenticatedFetch } from "@/lib/identity";

const MAX_TOOL = 120;
const MAX_LINE = 300;
const MAX_ARGS = 2000;
const TIMEOUT_MS = 20_000;

export interface AeAiSummaryBody {
  tool: string;
  line: string;
  args: string;
}

/** The request for a card, or null when the card must not call the model. */
export function aeAiSummaryBody(summary: ApprovalSummary): AeAiSummaryBody | null {
  if (summary.source === "agent") return null;
  const tool = scrub(
    summary.title ??
      (summary.kind === "edit"
        ? "Edit a file"
        : summary.kind === "tool"
          ? "Tool request"
          : "Run a command"),
  ).slice(0, MAX_TOOL);
  return {
    tool,
    line: scrub(summary.text).slice(0, MAX_LINE),
    args: scrub(summary.code ?? "").slice(0, MAX_ARGS),
  };
}

async function fetchSummary(body: AeAiSummaryBody): Promise<string | null> {
  const res = await authenticatedFetch("/v1/ae/approval-summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`POST /v1/ae/approval-summary answered ${res.status}`);
  const text = ((await res.json()) as { text?: unknown } | null)?.text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

// A card rendered with no QueryClientProvider (a test, a bare preview) keeps today's card:
// the hook runs a disabled query on this client instead of throwing.
const NO_PROVIDER_CLIENT = new QueryClient();

function useOptionalQueryClient(): QueryClient {
  try {
    return useQueryClient();
  } catch {
    return NO_PROVIDER_CLIENT;
  }
}

/** The AI sentence for a pending card's summary, or null while it loads, fails or is not asked for. */
export function useAeAiSummary(summary: ApprovalSummary): string | null {
  const body = aeAiSummaryBody(summary);
  const client = useOptionalQueryClient();
  const query = useQuery(
    {
      // The body is the key: the same card text is asked once, and a changed preview asks again.
      queryKey: ["ae", "approval-summary", body],
      queryFn: () => fetchSummary(body as AeAiSummaryBody),
      enabled: body !== null && client !== NO_PROVIDER_CLIENT,
      staleTime: Infinity,
      gcTime: 10 * 60 * 1000,
      retry: false,
      refetchOnWindowFocus: false,
    },
    client,
  );
  return body ? (query.data ?? null) : null;
}
