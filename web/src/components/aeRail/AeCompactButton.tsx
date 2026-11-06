// Compact, queued (omnigent-ae). The rail's Context section and the action dock's
// Compact card both use it, so it lives in a file of its own: the vitest suites mock
// whole component modules, and a missing export fails every test that renders them.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cancelAeCompactPlan, startAeCompactPlan, useAeCompactPlan } from "@/lib/aeCompactPlan";
import { useChatStore } from "@/store/chatStore";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Two clicks within three seconds queue a compact. It never runs on the spot: the server
 * waits for the end of a real turn, has the chat save what is worth keeping, then compacts
 * (see aeCompactPlan.ts), whether or not this chat stays open. A queued compact shows Cancel.
 * With `sessionId` (the dock card) the server also snoozes the suggestion once it compacted.
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
      if (targetId) cancelAeCompactPlan(targetId).catch((e: unknown) => setError(reason(e)));
      return;
    }
    if (plan === "compacting") return;
    if (!confirming) {
      setError(null);
      setConfirming(true);
      return;
    }
    setConfirming(false);
    if (!targetId) return;
    startAeCompactPlan(targetId, { snooze: Boolean(sessionId) }).catch((e: unknown) =>
      setError(reason(e)),
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
