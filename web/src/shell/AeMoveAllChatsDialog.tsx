// "Move all open chats to <login>?" (omnigent-ae, 2026-10-27). Shown after the
// login for new chats changes; mounted once in the app shell. "Only new chats"
// holds the initial focus, so Enter keeps the pick as it was before this existed.

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
  AE_MOVE_ALL_CAUTION,
  aeMoveAllSummary,
  aeRefreshChatAccountSoon,
  moveAllAeClaudeChats,
} from "@/lib/aeClaudeAccount";
import { dismissAeMoveAll, useAeMoveAllRequest } from "@/lib/aeMoveAllChats";

export function AeMoveAllChatsDialog() {
  const request = useAeMoveAllRequest();
  const queryClient = useQueryClient();
  const keepRef = useRef<HTMLButtonElement>(null);
  const moveAll = () => {
    if (!request) return;
    const { account, hostId } = request;
    dismissAeMoveAll();
    moveAllAeClaudeChats(account, hostId).then(
      (answer) => {
        for (const id of [...answer.moved, ...answer.pending.map((p) => p.id)]) {
          aeRefreshChatAccountSoon(queryClient, id);
        }
        showToast(aeMoveAllSummary(answer));
      },
      (failure: unknown) =>
        showToast(failure instanceof Error ? failure.message : "Could not move the open chats."),
    );
  };
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && dismissAeMoveAll()}>
      <DialogContent
        data-testid="ae-move-all-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          keepRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Move all open chats to {request?.label}?</DialogTitle>
          <DialogDescription>{AE_MOVE_ALL_CAUTION}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            ref={keepRef}
            type="button"
            variant="outline"
            onClick={dismissAeMoveAll}
            title="Keep every open chat on the login it has; only new chats use this one"
            data-testid="ae-move-all-keep"
          >
            Only new chats
          </Button>
          <Button
            type="button"
            onClick={moveAll}
            title="Restart each open chat on this login"
            data-testid="ae-move-all-confirm"
          >
            Move all chats
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
