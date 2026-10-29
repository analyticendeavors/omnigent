// The Usage card's subscription switcher: the Claude account name in the card's
// header, as a menu of every Claude login the box knows. Picking one shows that
// account's usage; the chat itself stays on its own login. omnigent-ae, 2026-10-27.
// Since 2026-10-28 the trigger is a bordered chip beside the title (not inside its
// truncating span), and each row carries a second line from `renderDetail`.
// The chip also carries the plan (it belongs to the login), a users icon for a shared
// login, and an amber edge while it shows a login other than the chat's own.

import type { ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import { AE_MENU_WIDTH_CLASS } from "@/lib/aeMenuRow";
import { AE_SHARED_ACCOUNT_PREFIX, aeIsSharedAccount } from "@/lib/aeSharedClaudeAccounts";
import { cn } from "@/lib/utils";

/** One Claude login from `GET /v1/ae/limits/accounts`; `account` is null for the default login. */
export interface AeLimitAccountRow {
  harness: string;
  account: string | null;
  label: string;
  plan: string | null;
}

/** The menu value for an account: the empty string is the default login. */
export const aeAccountKey = (account: string | null | undefined): string => account ?? "";

/** Tabler's `users` (@tabler/icons 3.46.0), inlined to mark a shared login. */
const USERS_ICON: AeTablerIconNode = [
  ["path", { d: "M5 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0" }],
  ["path", { d: "M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" }],
  ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75" }],
  ["path", { d: "M21 21v-2a4 4 0 0 0 -3 -3.85" }],
];

const TRIGGER_HELP = "View another subscription's usage. This chat stays on its own login.";

export function AeLimitsAccountMenu({
  rows,
  ownKey,
  selectedKey,
  label,
  plan,
  viewingOther,
  onOpenChange,
  onSelect,
  renderDetail,
}: {
  /** Claude logins; empty until the menu is first opened. */
  rows: readonly AeLimitAccountRow[];
  /** The key of the account this chat runs on. */
  ownKey: string;
  /** The key of the account whose usage the card shows. */
  selectedKey: string;
  /** The shown account's name; null when the host names none (the default login). */
  label: string | null;
  /** The shown login's plan, drawn inside the chip; it belongs to the login. */
  plan?: string | null;
  /** True when the card shows a login other than the chat's own. */
  viewingOther?: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (key: string) => void;
  /** A second muted line under a row's label; null renders nothing. */
  renderDetail?: (key: string) => ReactNode;
}) {
  const shared = aeIsSharedAccount(selectedKey);
  // A shared login's label falls back to its raw key before the list loads.
  const shownLabel =
    label && shared
      ? label.replace(AE_SHARED_ACCOUNT_PREFIX, "").replace(/ \(shared\)$/, "")
      : label;
  const fullName = label ?? "Default login";
  const spoken = `${shownLabel ?? fullName}${shared ? " (shared)" : ""}${plan ? `, ${plan}` : ""}${viewingOther ? ", viewing another login" : ""}`;
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="ae-limits-account-menu"
          title={`${spoken}. ${TRIGGER_HELP}`}
          aria-label={spoken}
          data-viewing-other={viewingOther || undefined}
          className={cn(
            "-my-0.5 ml-auto inline-flex max-w-full min-w-0 shrink-[0.0001] cursor-pointer items-center gap-0.5 rounded-md border bg-muted/40 px-2 py-0.5 text-xs font-normal outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
            viewingOther
              ? "border-amber-500/60 text-amber-700 dark:text-amber-400"
              : "border-border text-foreground",
          )}
        >
          {shared && (
            <span className="contents" data-testid="ae-limits-account-shared">
              <AeTablerSvg node={USERS_ICON} className="size-3 shrink-0" />
            </span>
          )}
          <span
            className="min-w-0 truncate pr-0.5"
            data-testid={label ? "ae-limits-account" : undefined}
          >
            {shownLabel ?? "Default login"}
          </span>
          {plan && (
            <span className="shrink-0 text-muted-foreground">
              {" · "}
              <span data-testid="ae-limits-plan">{plan}</span>
            </span>
          )}
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={cn(AE_MENU_WIDTH_CLASS, "max-h-[60vh] overflow-y-auto")}
        aria-label="Claude subscription"
      >
        <DropdownMenuRadioGroup value={selectedKey} onValueChange={onSelect}>
          {rows.map((row) => {
            const key = aeAccountKey(row.account);
            return (
              <DropdownMenuRadioItem
                key={key}
                value={key}
                data-testid="ae-limits-account-option"
                className="gap-2"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2">
                    <span>{row.label}</span>
                    {row.plan && <span className="text-muted-foreground">{row.plan}</span>}
                    {key === ownKey && (
                      <span
                        className="rounded border border-border px-1 text-xs text-muted-foreground"
                        data-testid="ae-limits-account-own"
                        title="This chat runs on this login."
                      >
                        This chat
                      </span>
                    )}
                  </span>
                  {renderDetail?.(key)}
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
