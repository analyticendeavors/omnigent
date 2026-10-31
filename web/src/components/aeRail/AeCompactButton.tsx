// Compact, queued (omnigent-ae). The rail's Context section and the action dock's
// Compact card both use it, so it lives in a file of its own: the vitest suites mock
// whole component modules, and a missing export fails every test that renders them.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { showToast } from "@/components/ui/toast";
import { aeSnoozeFailureIsQuiet, postAeHandoffSnooze } from "@/lib/aeCompactSuggestion";
import { cancelAeCompactPlan, startAeCompactPlan, useAeCompactPlan } from "@/lib/aeCompactPlan";
import { useChatStore } from "@/store/chatStore";

/**
 * Two clicks within three seconds queue a compact. It never runs on the spot: at a safe
 * point the chat first saves what is worth keeping, then compacts (see aeCompactPlan.ts).
 * A queued compact shows Cancel. With `sessionId` (the dock card) it first checks the chat
 * open in the store is that session, and snoozes the suggestion once the compact went out.
 */
export function AeCompactButton({
  sessionId,
  testId = "ae-rail-compact",
}: {
  sessionId?: string;
  testId?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openId = useChatStore((s) => s.conversationId);
  const busy = useChatStore((s) => s.status === "streaming" || s.sessionStatus === "running");
  const targetId = sessionId ?? openId;
  const plan = useAeCompactPlan(targetId);
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = window.setTimeout(() => setConfirming(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const onClick = () => {
    if (plan === "queued" || plan === "preparing") {
      if (targetId) cancelAeCompactPlan(targetId);
      return;
    }
    if (plan === "compacting") return;
    if (!confirming) {
      setError(null);
      setConfirming(true);
      return;
    }
    setConfirming(false);
    if (!openId || (sessionId && openId !== sessionId)) {
      setError("This chat is not open here. Open it, then compact.");
      return;
    }
    startAeCompactPlan(
      openId,
      sessionId
        ? () => {
            postAeHandoffSnooze(sessionId).catch((reason: unknown) => {
              if (aeSnoozeFailureIsQuiet(reason)) return;
              showToast(
                `Compacting started, but the card could not be snoozed (${
                  reason instanceof Error ? reason.message : String(reason)
                }).`,
              );
            });
          }
        : undefined,
    );
  };
  const label =
    plan === "queued"
      ? "Cancel compact"
      : plan === "preparing"
        ? "Saving notes... Cancel"
        : plan === "compacting"
          ? "Compacting..."
          : confirming
            ? busy
              ? "Queue compact?"
              : "Compact now?"
            : "Compact";
  const title =
    plan === "queued"
      ? "Compact is queued. The chat saves its notes when it goes idle, then compacts."
      : plan === "preparing"
        ? "The chat is saving its notes. It compacts when that turn ends."
        : busy
          ? "The chat is running. Compact waits for a safe point."
          : undefined;
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant={confirming ? "destructive" : "outline"}
        disabled={plan === "compacting"}
        title={title}
        onClick={onClick}
        data-testid={testId}
        data-compact-plan={plan ?? undefined}
        className="shrink-0"
      >
        {label}
      </Button>
      {error && (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
