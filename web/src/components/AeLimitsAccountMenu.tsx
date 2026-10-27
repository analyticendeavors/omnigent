// The Usage card's subscription switcher: the Claude account name in the card's
// header, as a menu of every Claude login the box knows. Picking one shows that
// account's usage; the chat itself stays on its own login. omnigent-ae, 2026-10-27.

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
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="ae-limits-account-menu"
          title={TRIGGER_HELP}
          className="inline-flex max-w-full cursor-pointer items-center gap-0.5 rounded-sm align-baseline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="truncate" data-testid={label ? "ae-limits-account" : undefined}>
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
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
