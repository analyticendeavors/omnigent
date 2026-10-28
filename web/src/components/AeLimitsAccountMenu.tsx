// The Usage card's subscription switcher: the Claude account name in the card's
// header, as a menu of every Claude login the box knows. Picking one shows that
// account's usage; the chat itself stays on its own login. omnigent-ae, 2026-10-27.
// Since 2026-10-28 the trigger is a bordered chip beside the title (not inside its
// truncating span), and each row carries a second line from `renderDetail`.

import type { ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AE_MENU_WIDTH_CLASS } from "@/lib/aeMenuRow";
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

const TRIGGER_HELP = "View another subscription's usage. This chat stays on its own login.";

export function AeLimitsAccountMenu({
  rows,
  ownKey,
  selectedKey,
  label,
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
  onOpenChange: (open: boolean) => void;
  onSelect: (key: string) => void;
  /** A second muted line under a row's label; null renders nothing. */
  renderDetail?: (key: string) => ReactNode;
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="ae-limits-account-menu"
          title={`${label ?? "Default login"}. ${TRIGGER_HELP}`}
          className="-my-0.5 inline-flex max-w-full min-w-0 shrink-[0.0001] cursor-pointer items-center gap-0.5 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs font-normal text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span
            className="min-w-0 truncate pr-0.5"
            data-testid={label ? "ae-limits-account" : undefined}
          >
            {label ?? "Default login"}
          </span>
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
