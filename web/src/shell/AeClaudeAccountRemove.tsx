// Remove a personal Claude login from Settings (omnigent-ae, 2026-10-20): the
// Remove button beside Rename and the one-line confirm it opens. The delete is
// the host's `claude-oauth-delete` write; `ClaudeAccounts.tsx` only holds which
// row is confirming.

import { Button } from "@/components/ui/button";
import type { useStoreCredential } from "@/hooks/useHosts";

export function AeClaudeAccountRemoveButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="text-destructive"
      aria-label={`Remove ${label}`}
      disabled={disabled}
      onClick={onClick}
    >
      Remove
    </Button>
  );
}

export function AeClaudeAccountRemoveConfirm({
  hostName,
  accountId,
  label,
  selected,
  store,
  onDone,
  onFail,
  onCancel,
}: {
  hostName: string;
  accountId: string;
  label: string;
  /** The login new chats start with today; removing it hands them the default CLI login. */
  selected: boolean;
  store: ReturnType<typeof useStoreCredential>;
  onDone: () => void;
  onFail: (error: Error) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="min-w-0 flex-1 text-xs">
        Removes {label} and its token from {hostName}. Running chats keep their token until they
        restart.{selected ? " New chats use the Default CLI account." : ""}
      </span>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={store.isPending}
        onClick={() =>
          store.mutate(
            { harness: "claude-native", kind: "claude-oauth-delete", account_name: accountId },
            { onSuccess: onDone, onError: onFail },
          )
        }
      >
        Remove account
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={store.isPending} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
