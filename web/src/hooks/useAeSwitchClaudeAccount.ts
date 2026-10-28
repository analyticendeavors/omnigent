// Switch one chat's Claude login in place (omnigent-ae, 2026-10-27). The chat's
// snapshot is re-read afterwards so every picker shows the new login.
// `includeChildren` (2026-10-28) moves the chat's family children with it.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { aeRefreshChatAccount, putAeClaudeAccount } from "@/lib/aeClaudeAccount";

export function useAeSwitchClaudeAccount(sessionId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ account, includeChildren }: { account: string; includeChildren?: boolean }) =>
      putAeClaudeAccount(sessionId ?? "", account, includeChildren === true),
    onSettled: () => aeRefreshChatAccount(queryClient, sessionId ?? null),
  });
}
