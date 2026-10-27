// The "This chat" group of the composer's Account submenu (omnigent-ae,
// 2026-10-27): the Claude login this chat runs on, ticked, and a pick restarts
// the chat on that login (`PUT /v1/ae/sessions/{id}/claude-account`). A pick is
// refused while a reply runs, or when the server says no; the reason shows
// under the rows. The "New chats" heading below it belongs to the same split.

import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useAeSwitchClaudeAccount } from "@/hooks/useAeSwitchClaudeAccount";
import type { DetectedCredential } from "@/hooks/useHosts";
import { useSession } from "@/hooks/useSession";
import {
  AE_NEW_CHATS_HEADING,
  AE_THIS_CHAT_BUSY_HINT,
  AE_THIS_CHAT_HEADING,
  AE_THIS_CHAT_HINT,
  aeChatAccount,
} from "@/lib/aeClaudeAccount";
import { AE_MENU_NOTE_CLASS } from "@/lib/aeMenuRow";
import { AeSharedAccountMarker, aeIsSharedAccount } from "@/lib/aeSharedClaudeAccounts";
import { cn } from "@/lib/utils";

// Radix radio values are never empty here: "" is the default login's id.
const DEFAULT_VALUE = "__default__";
const UNKNOWN_VALUE = "__unknown__";
const toValue = (account: string) => (account === "" ? DEFAULT_VALUE : account);

const RADIO_ROW_CLASS =
  "min-h-8 pr-2! pl-7! whitespace-normal break-words [&>[data-slot=dropdown-menu-radio-item-indicator]]:right-auto [&>[data-slot=dropdown-menu-radio-item-indicator]]:left-1.5";

/**
 * The login name the trigger shows for this chat, or `fallback` while it is
 * unknown. A login the host no longer lists shows as unavailable, never as the
 * host's active one.
 */
export function AeChatAccountName({
  sessionId,
  rows,
  fallback,
}: {
  sessionId: string;
  rows: readonly DetectedCredential[];
  fallback: string;
}) {
  const { session } = useSession(sessionId);
  const account = aeChatAccount(session?.labels);
  if (account === undefined) return fallback;
  const row = rows.find((r) => (r.env_var ?? "") === account);
  if (row) return row.source;
  const name = account === "" ? "Default login" : account.replace(/^shared:/, "");
  return (
    <span className="text-destructive" data-testid="composer-claude-account-unavailable">
      {name} (unavailable)
    </span>
  );
}

export function AeThisChatAccounts({
  sessionId,
  rows,
  turnBusy,
}: {
  sessionId: string;
  rows: readonly DetectedCredential[];
  /** A reply is running, so the chat cannot restart. */
  turnBusy: boolean;
}) {
  const { session } = useSession(sessionId);
  const change = useAeSwitchClaudeAccount(sessionId);
  const current = aeChatAccount(session?.labels);
  const disabled = turnBusy || change.isPending;
  return (
    <>
      <DropdownMenuLabel className="px-2 py-1 text-xs" data-testid="composer-claude-account-chat">
        {AE_THIS_CHAT_HEADING}
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={current === undefined ? UNKNOWN_VALUE : toValue(current)}
        aria-label={AE_THIS_CHAT_HEADING}
      >
        {rows.map((row) => {
          const accountId = row.env_var ?? "";
          return (
            <DropdownMenuRadioItem
              key={accountId}
              value={toValue(accountId)}
              disabled={disabled}
              title={turnBusy ? AE_THIS_CHAT_BUSY_HINT : AE_THIS_CHAT_HINT}
              className={cn(RADIO_ROW_CLASS, "flex items-center gap-2")}
              onSelect={(event) => {
                event.preventDefault();
                if (accountId !== current) change.mutate(accountId);
              }}
              data-testid={`composer-claude-account-chat-${accountId || "default"}`}
            >
              <span className="min-w-0 flex-1 truncate">{row.source}</span>
              {aeIsSharedAccount(accountId) && <AeSharedAccountMarker />}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
      {turnBusy && (
        <p
          className={cn(AE_MENU_NOTE_CLASS, "px-2 py-1 text-xs text-muted-foreground")}
          data-testid="composer-claude-account-chat-busy"
        >
          {AE_THIS_CHAT_BUSY_HINT}
        </p>
      )}
      {change.error && (
        <p
          role="alert"
          className={cn(AE_MENU_NOTE_CLASS, "px-2 py-1 text-xs text-destructive")}
          data-testid="composer-claude-account-chat-error"
        >
          {change.error.message}
        </p>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="px-2 py-1 text-xs" data-testid="composer-claude-account-new">
        {AE_NEW_CHATS_HEADING}
      </DropdownMenuLabel>
    </>
  );
}
