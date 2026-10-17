// The chat header's ways into the session rail: a desktop toggle beside the
// right-panel toggle, and a "Session rail" item in the phone's session menu.

import type { ReactNode } from "react";
import { AeRailIcon } from "@/components/aeRail/aeRailUi";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { cn } from "@/lib/utils";

/** Desktop only (hidden below md); the phone opens the rail from the session menu. */
export function AeSessionRailToggle() {
  const open = useAeSessionRailStore((s) => s.open);
  const toggle = useAeSessionRailStore((s) => s.toggle);
  const label = open ? "Hide session rail" : "Show session rail";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-pressed={open}
          onClick={toggle}
          componentId="chat.header.toggle_session_rail"
          className={cn(
            "hidden md:inline-flex text-muted-foreground hover:text-foreground border-none",
            open && "bg-muted text-foreground",
          )}
        >
          <AeRailIcon name={open ? "railCollapse" : "railExpand"} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function AeSessionRailMenuItem() {
  const setSheetOpen = useAeSessionRailStore((s) => s.setSheetOpen);
  return (
    <DropdownMenuItem
      onSelect={() => setSheetOpen(true)}
      data-testid="mobile-session-rail"
      className="gap-2.5 px-2.5 py-2 text-ui"
    >
      <AeRailIcon name="rail" />
      Session rail
    </DropdownMenuItem>
  );
}

/** The phone menu's workspace items with "Session rail" first, when `show`. */
export function aeWithSessionRailItem(show: unknown, items: ReactNode): ReactNode {
  if (!show) return items;
  return (
    <>
      <AeSessionRailMenuItem />
      {items}
    </>
  );
}
