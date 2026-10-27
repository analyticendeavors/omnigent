// The Claude login the account picker has selected for new chats, as the usage
// panels send it to `GET /v1/ae/limits?account=`: a chat that has not replied
// yet has no reading of its own, and the server answers it for this account
// rather than with the host's reading of another one. omnigent-ae, 2026-10-26.

import { useDetectedCredentials } from "@/hooks/useHosts";
import { useSession } from "@/hooks/useSession";
import { aePickedClaudeAccount } from "@/lib/aeLimitGate";
import { isTempConvId } from "@/lib/tempConversationId";
import { useChatStore } from "@/store/chatStore";

/**
 * @param sessionId - The chat the usage panel is for; its host is asked.
 * @param enabled - Only a Claude chat has an account to name.
 * @returns `account` is `""` for the default login and `undefined` when none
 *   can be named; `ready` is false until the host's logins have answered (or
 *   failed to), so a panel waits for them instead of showing the default
 *   login's numbers first.
 */
export function useAePickedClaudeAccount(
  sessionId: string | null | undefined,
  enabled: boolean,
): { account: string | undefined; ready: boolean } {
  const on = enabled && Boolean(sessionId);
  // A new chat's `temp:` id has no server session yet: its host is the one the composer seeded.
  const temp = isTempConvId(sessionId);
  const { session, isLoading } = useSession(on && !temp ? sessionId : null);
  const seededHostId = useChatStore((s) =>
    s.conversationId === sessionId ? s.sessionHostId : null,
  );
  const hostId = temp ? seededHostId : session?.hostId;
  const credentials = useDetectedCredentials(hostId, on);
  if (!on) return { account: undefined, ready: true };
  const hostKnown = Boolean(hostId);
  // Cached logins from before a pick are stale while a refetch is in flight: wait it out,
  // or the session's first hint (frozen for good) would be the previous pick.
  const settled = (credentials.isSuccess || credentials.isError) && !credentials.isFetching;
  return {
    account: credentials.data && settled ? aePickedClaudeAccount(credentials.data) : undefined,
    ready: !isLoading && (!hostKnown || settled),
  };
}
