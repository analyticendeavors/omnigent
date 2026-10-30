// "Switch the child chats too?" (omnigent-ae, 2026-10-28). Shown when a chat that has
// child chats is moved to another Claude login; mounted once in the app shell.
// "Parent and children" holds the initial focus, so Enter moves the whole family.

import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { showToast } from "@/components/ui/toast";
import {
  aeRefreshChatAccountSoon,
  aeSwitchSummary,
  aeSwitchedChildIds,
  putAeClaudeAccount,
} from "@/lib/aeClaudeAccount";
import { dismissAeSwitchFamily, useAeSwitchFamilyRequest } from "@/lib/aeSwitchFamily";

export function AeSwitchFamilyDialog() {
  const live = useAeSwitchFamilyRequest();
  // Keep the last question so the text does not go blank while the dialog fades out.
  const lastRef = useRef(live);
  if (live) lastRef.current = live;
  const request = live ?? lastRef.current;
  const queryClient = useQueryClient();
  const bothRef = useRef<HTMLButtonElement>(null);
  const count = request?.childCount ?? 0;
  const chats = `${count} child ${count === 1 ? "chat" : "chats"}`;
  const run = (includeChildren: boolean) => {
    if (!live) return;
    const { sessionId, account, label } = live;
    dismissAeSwitchFamily();
    // Not the mutation hook: it reads its session id from the request, which is gone by now.
    putAeClaudeAccount(sessionId, account, includeChildren).then(
      (answer) => {
        for (const id of [sessionId, ...aeSwitchedChildIds(answer)]) {
          aeRefreshChatAccountSoon(queryClient, id);
        }
        const kids = answer.children;
        // A skipped or slow child stays on screen until dismissed, so it can be retried.
        const lingers = kids && (kids.error || kids.skipped.length > 0 || kids.pending.length > 0);
        showToast(aeSwitchSummary(label, answer), lingers ? { duration: 0 } : undefined);
      },
      (failure: unknown) => {
        aeRefreshChatAccountSoon(queryClient, sessionId);
        showToast(failure instanceof Error ? failure.message : "Could not switch the login.");
      },
    );
  };
  return (
    <Dialog open={live !== null} onOpenChange={(open) => !open && dismissAeSwitchFamily()}>
      <DialogContent
        data-testid="ae-switch-family-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          bothRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Switch the child chats too?</DialogTitle>
          <DialogDescription>
            This chat has {chats}. Each moved chat restarts on {request?.label} and re-reads its
            conversation (extra tokens). A child that is mid-reply or waiting on an approval is
            skipped and listed so you can retry it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            ref={bothRef}
            type="button"
            onClick={() => run(true)}
            title={`Restart this chat and its ${chats} on ${request?.label}`}
            data-testid="ae-switch-family-both"
          >
            Parent and children
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => run(false)}
            title="Only this chat moves; its children finish on the login they have"
            data-testid="ae-switch-family-parent"
          >
            Parent only
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
