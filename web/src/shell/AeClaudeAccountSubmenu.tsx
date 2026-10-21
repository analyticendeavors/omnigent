// The Account row of the chat composer's model menu (omnigent-ae, 2026-10-20).
// One row, "Account" with the login new chats use, opening a submenu of the
// host's Claude logins and the shared ones; picking one is the same
// `claude-oauth-select` write Settings makes. Replaces the two-column grid of
// account buttons that sat above the models.

import { useState } from "react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useDetectedCredentials, useStoreCredential, type Host } from "@/hooks/useHosts";
import { AE_MENU_ROW_CLASS } from "@/lib/aeMenuRow";
import { AeSharedAccountMarker, aeIsSharedAccount } from "@/lib/aeSharedClaudeAccounts";
import { cn } from "@/lib/utils";

/** The row changes the host's default for new chats; a running chat keeps its login. */
export const AE_ACCOUNT_SCOPE = "For new chats. This chat keeps the login it started with.";

export function AeClaudeAccountSubmenu({
  host,
  disabled = false,
}: {
  host: Host | null | undefined;
  /** Another configuration change is running. */
  disabled?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const accounts = useDetectedCredentials(host?.host_id, !!host);
  const store = useStoreCredential(host?.host_id ?? "");
  if (!host) return null;
  const rows = (accounts.data ?? []).filter((row) => row.family.startsWith("claude-oauth"));
  const active = rows.find((row) => row.family === "claude-oauth-active");
  // A host with no Claude login detected answers with no rows: that is a
  // configuration problem, not a slow read.
  const unavailable = accounts.isError || (accounts.isSuccess && rows.length === 0);
  const value = unavailable
    ? "Unavailable"
    : rows.length === 0
      ? "Loading…"
      : (active?.source ?? "Default CLI account");
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        data-testid="composer-claude-account"
        className="pl-7 [&>svg:last-child]:ml-1"
        title={AE_ACCOUNT_SCOPE}
      >
        Account
        <span
          className="ml-auto min-w-0 truncate text-muted-foreground"
          data-testid="composer-claude-account-value"
        >
          {value}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[70vh] max-w-[calc(100vw-2rem)] overflow-y-auto">
        <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground" data-testid="composer-claude-account-scope">
          {AE_ACCOUNT_SCOPE}
        </p>
        {rows.map((row) => {
          const accountId = row.env_var ?? "";
          const current = row.family === "claude-oauth-active";
          return (
            <DropdownMenuCheckboxItem
              key={accountId}
              checked={current}
              disabled={disabled || store.isPending || current}
              className={cn(AE_MENU_ROW_CLASS, "flex items-center gap-2")}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={() => {
                setError(null);
                store.mutate(
                  { harness: "claude-native", kind: "claude-oauth-select", account_name: accountId },
                  { onError: (failure) => setError(failure.message) },
                );
              }}
              data-testid={`composer-claude-account-${accountId || "default"}`}
            >
              <span className="min-w-0 flex-1 truncate">{row.source}</span>
              {aeIsSharedAccount(accountId) && <AeSharedAccountMarker />}
            </DropdownMenuCheckboxItem>
          );
        })}
        {unavailable && (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            Could not load Claude accounts. Check the host account configuration.
          </p>
        )}
        {error && (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
