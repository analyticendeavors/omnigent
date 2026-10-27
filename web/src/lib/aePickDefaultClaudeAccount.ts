// Pick the Claude login new chats use, then ask whether every open chat should
// move to it too (omnigent-ae, 2026-10-27). Wraps the `claude-oauth-select`
// write the composer menu and Settings both make.

import { askAeMoveAll } from "@/lib/aeMoveAllChats";
import type { StoreCredentialInput } from "@/hooks/useHosts";

interface SelectMutation {
  mutate: (
    input: StoreCredentialInput,
    options: { onSuccess?: () => void; onError?: (error: Error) => void },
  ) => void;
}

export function aePickDefaultClaudeAccount(store: SelectMutation, hostId: string | undefined) {
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
          askAeMoveAll({ account, label, hostId });
        },
        onError: callbacks.onError,
      },
    );
}
