// Switch one chat's Claude login in place (omnigent-ae, 2026-10-27). The chat's
// snapshot is re-read afterwards so every picker shows the new login.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { aeRefreshChatAccount, putAeClaudeAccount } from "@/lib/aeClaudeAccount";

export function useAeSwitchClaudeAccount(sessionId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (account: string) => putAeClaudeAccount(sessionId ?? "", account),
    onSettled: () => aeRefreshChatAccount(queryClient, sessionId ?? null),
  });
}
