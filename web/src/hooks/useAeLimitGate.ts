// The action dock's usage gate item: the session's own limits answer (one
// shared query per session, refetched each minute), the gate over it, and
// dismissals that last until that window resets. omnigent-ae, 2026-10-21.

import { useState } from "react";
import { useAeLimits } from "@/components/AePlanLimits";
import { aeLimitsHarnessFor } from "@/components/aeSessionContext";
import { useAePickedClaudeAccount } from "@/hooks/useAePickedClaudeAccount";
import { useDetectedCredentials } from "@/hooks/useHosts";
import { useSession } from "@/hooks/useSession";
import type { AeDockLimit } from "@/lib/aeActionDock";
import { aeChatAccount } from "@/lib/aeClaudeAccount";
import {
  type AeLimitDismissal,
  aeLimitGate,
  aeLimitGateDismiss,
  aeOtherClaudeAccounts,
} from "@/lib/aeLimitGate";
import { useForkDialog } from "@/shell/ForkDialogContext";
import { useChatStore } from "@/store/chatStore";

/**
 * One list for every chat: the window is the account's, so a dismissal in one
 * chat holds in the others on that account. Bounded by AE_LIMIT_GATE_DISMISS_KEEP.
 */
const DISMISSED_KEY = "ae-action-dock:limit-dismissed";

function readDismissed(): AeLimitDismissal[] | null {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (d): d is AeLimitDismissal =>
        !!d &&
        typeof d === "object" &&
        typeof (d as AeLimitDismissal).window === "string" &&
        (typeof (d as AeLimitDismissal).resets === "number" ||
          (d as AeLimitDismissal).resets === null),
    );
  } catch {
    return null;
  }
}

function writeDismissed(dismissed: readonly AeLimitDismissal[]) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
  } catch {
    // Storage off: the dismissal lasts until the page reloads.
  }
}

export function useAeLimitGate(sessionId: string | undefined): {
  item: AeDockLimit | null;
  dismiss: () => void;
} {
  const harness = useChatStore((s) =>
    sessionId && s.conversationId === sessionId ? aeLimitsHarnessFor(s.sessionHarness) : null,
  );
  const picked = useAePickedClaudeAccount(sessionId, harness === "claude");
  const { data } = useAeLimits(
    Boolean(sessionId && harness) && picked.ready,
    sessionId,
    picked.account,
  );
  const [dismissed, setDismissed] = useState(() => readDismissed() ?? []);
  const gate = aeLimitGate(data, harness, Date.now(), dismissed);
  const claude = gate?.harness === "claude";
  // Read only while a Claude gate shows: the host's logins and the session's own.
  const { session } = useSession(claude ? sessionId : null);
  const credentials = useDetectedCredentials(session?.hostId, claude);
  const forkDialog = useForkDialog();
  if (!gate) return { item: null, dismiss: () => {} };
  // The opener forks the shell's own session and does nothing while a reason blocks it.
  const forkable =
    Boolean(forkDialog?.canFork) &&
    !forkDialog?.disabledReason &&
    forkDialog?.currentSessionId === sessionId;
  const accountChoices = claude
    ? aeOtherClaudeAccounts(credentials.data ?? [], aeChatAccount(session?.labels))
    : [];
  return {
    item: {
      kind: "limit",
      key: `limit:${gate.windowKey}`,
      anchor: `limit:${gate.windowKey}`,
      order: 0,
      gate,
      windows: data?.harnesses?.[gate.harness]?.windows,
      canSwitchAccount: accountChoices.length > 0,
      accountChoices,
      canCopyAccount: accountChoices.length > 0 && forkable,
    },
    dismiss: () => {
      // Another chat may have dismissed since this one mounted: start from storage.
      const next = aeLimitGateDismiss(readDismissed() ?? dismissed, gate);
      writeDismissed(next);
      setDismissed(next);
    },
  };
}
