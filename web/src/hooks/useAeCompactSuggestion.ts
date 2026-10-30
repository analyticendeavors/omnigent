// The Compact card's data (omnigent-ae, 2026-10-29): the session labels say
// whether to suggest, the chat store says whether this pane has that chat open.
// Labels come from the rail's live cache, so the phone, the desktop and every
// tab agree.

import { useMemo } from "react";
import { useAeRailSessionRow } from "@/components/aeRail/aeRailSessionData";
import type { AeDockContext } from "@/lib/aeActionDock";
import { aeCompactSuggestion } from "@/lib/aeCompactSuggestion";
import { useChatStore } from "@/store/chatStore";

export function useAeCompactSuggestion(sessionId: string | undefined): {
  /** The labels ask for compacting (the rail's line). */
  tokens: number | null;
  /** The dock card: the same, and this is the chat open in the store. */
  item: AeDockContext | null;
} {
  const row = useAeRailSessionRow(sessionId ?? "");
  const open = useChatStore((s) => Boolean(sessionId) && s.conversationId === sessionId);
  const suggestion = aeCompactSuggestion(row);
  const tokens = sessionId ? (suggestion?.tokens ?? null) : null;
  const item = useMemo<AeDockContext | null>(
    () =>
      sessionId && open && tokens !== null
        ? { kind: "context", key: "context", anchor: "context", order: 0, sessionId, tokens }
        : null,
    [sessionId, open, tokens],
  );
  return { tokens, item };
}
