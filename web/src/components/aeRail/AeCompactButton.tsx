// Compact, two clicks (omnigent-ae). The rail's Context section and the action
// dock's Compact card both use it, so it lives in a file of its own: the vitest
// suites mock whole component modules, and a missing export fails every test that
// renders them.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { showToast } from "@/components/ui/toast";
import { aeSnoozeFailureIsQuiet, postAeHandoffSnooze } from "@/lib/aeCompactSuggestion";
import { useChatStore } from "@/store/chatStore";

type CompactPhase = "idle" | "confirm" | "running";

/**
 * Two clicks within three seconds compact the session, as /compact does. With
 * `sessionId` (the dock card) it first checks the chat open in the store is that
 * session, and snoozes the suggestion once the compact went out. Disabled while
 * the chat is running, as the store refuses a compact then.
 */
export function AeCompactButton({
  sessionId,
  testId = "ae-rail-compact",
}: {
  sessionId?: string;
  testId?: string;
}) {
  const [phase, setPhase] = useState<CompactPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = useChatStore((s) => s.status === "streaming" || s.sessionStatus === "running");
  useEffect(() => {
    if (phase !== "confirm") return undefined;
    const timer = window.setTimeout(() => setPhase("idle"), 3000);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const onClick = () => {
    if (phase === "idle") {
      setError(null);
      setPhase("confirm");
      return;
    }
    if (phase !== "confirm") return;
    const store = useChatStore.getState();
    if (sessionId && store.conversationId !== sessionId) {
      setError("This chat is not open here. Open it, then compact.");
      setPhase("idle");
      return;
    }
    setPhase("running");
    store.compact().then(
      () => {
        setPhase("idle");
        if (sessionId) {
          postAeHandoffSnooze(sessionId).catch((reason: unknown) => {
            if (aeSnoozeFailureIsQuiet(reason)) return;
            showToast(
              `Compacting started, but the card could not be snoozed (${
                reason instanceof Error ? reason.message : String(reason)
              }).`,
            );
          });
        }
      },
      (reason: unknown) => {
        const detail = reason instanceof Error ? reason.message : String(reason);
        setError(
          `Could not compact the session (${detail}). Try again, or send /compact from the composer.`,
        );
        setPhase("idle");
      },
    );
  };
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant={phase === "confirm" ? "destructive" : "outline"}
        disabled={phase === "running" || busy}
        title={busy ? "Compact is disabled while a chat is in progress" : undefined}
        onClick={onClick}
        data-testid={testId}
        className="shrink-0"
      >
        {phase === "confirm" ? "Compact now?" : phase === "running" ? "Compacting..." : "Compact"}
      </Button>
      {error && (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
