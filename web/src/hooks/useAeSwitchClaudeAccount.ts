// Switch one chat's Claude login in place (omnigent-ae, 2026-10-27). The chat's
// snapshot is re-read afterwards so every picker shows the new login.
// `includeChildren` (2026-10-28) moves the chat's family children with it.
// The Usage numbers are re-read a few more times (2026-10-30): the runner stamps the new
// login only after it relaunches the terminal, after the switch has answered.

import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { aeRefreshChatAccountSoon, putAeClaudeAccount } from "@/lib/aeClaudeAccount";

export function useAeSwitchClaudeAccount(sessionId: string | null | undefined) {
  const queryClient = useQueryClient();
  const cancelRef = useRef<() => void>(() => {});
  // Stop the pending re-reads when the chat changes or the component goes away.
  useEffect(() => () => cancelRef.current(), [sessionId]);
  return useMutation({
    mutationFn: ({ account, includeChildren }: { account: string; includeChildren?: boolean }) =>
      putAeClaudeAccount(sessionId ?? "", account, includeChildren === true),
    onSettled: () => {
      cancelRef.current();
      cancelRef.current = aeRefreshChatAccountSoon(queryClient, sessionId ?? null);
    },
  });
}
