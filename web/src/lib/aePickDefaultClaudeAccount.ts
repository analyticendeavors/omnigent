// Pick the Claude login new chats use, and move every chat to it too (omnigent-ae,
// 2026-10-27; changed 2026-11-13: no question, every chat moves, open, closed, archived and
// busy ones). Wraps the `claude-oauth-select` write the composer menu and Settings both make.
// Before, a "Move all open chats?" dialog asked; "Only new chats" left every chat on the old
// login, and archived or mid-reply chats were never moved at all.

import type { QueryClient } from "@tanstack/react-query";
import { showToast } from "@/components/ui/toast";
import {
  aeMoveAllSummary,
  aeRefreshChatAccount,
  aeRefreshChatAccountSoon,
  moveAllAeClaudeChats,
} from "@/lib/aeClaudeAccount";
import type { StoreCredentialInput } from "@/hooks/useHosts";

interface SelectMutation {
  mutate: (
    input: StoreCredentialInput,
    options: { onSuccess?: () => void; onError?: (error: Error) => void },
  ) => void;
}

export function aePickDefaultClaudeAccount(
  store: SelectMutation,
  hostId: string | undefined,
  queryClient: QueryClient,
) {
  const moveEveryChat = (account: string, label: string) =>
    moveAllAeClaudeChats(account, hostId).then(
      (answer) => {
        const touched = [...answer.pending, ...(answer.queued ?? [])].map((p) => p.id);
        for (const id of [...answer.moved, ...touched]) {
          aeRefreshChatAccount(queryClient, id);
          aeRefreshChatAccountSoon(queryClient, id);
        }
        showToast(aeMoveAllSummary(answer, label));
      },
      (failure: unknown) =>
        showToast(failure instanceof Error ? failure.message : "Could not move the chats."),
    );
  return (
    account: string,
    label: string,
    callbacks: { onSuccess?: () => void; onError?: (error: Error) => void } = {},
  ) =>
    store.mutate(
      { harness: "claude-native", kind: "claude-oauth-select", account_name: account },
      {
        onSuccess: () => {
          callbacks.onSuccess?.();
          void moveEveryChat(account, label);
        },
        onError: callbacks.onError,
      },
    );
}
