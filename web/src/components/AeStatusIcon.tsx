// The `ae.status` icon on a sidebar session row: one lucide glyph per status,
// exposed as `role="img"` with the status word as its name, and the same word
// in a tooltip. Status is a label, never a title glyph (omnigent-ae
// `docs/LABELS.md`); the icon set was decided 2026-09-23.

import {
  ArchiveIcon,
  CircleCheckIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  CircleParkingIcon,
  type LucideIcon,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Conversation } from "@/hooks/useConversations";
import { type AeStatus, aeDisplayStatus } from "@/lib/aeLabels";
import { cn } from "@/lib/utils";

export const AE_STATUS_ICONS: Record<AeStatus, LucideIcon> = {
  working: CirclePlayIcon,
  blocked: CirclePauseIcon,
  review: CircleCheckIcon,
  parked: CircleParkingIcon,
  reference: ArchiveIcon,
};

/** The status word as the tooltip and accessible name show it. */
export const AE_STATUS_WORDS: Record<AeStatus, string> = {
  working: "Working",
  blocked: "Blocked",
  review: "Review",
  parked: "Parked",
  reference: "Reference",
};

// Working holds a slot and blocked is waiting on the human, so both read in
// the accent tone; the three resting states stay muted.
const TONES: Record<AeStatus, string> = {
  working: "text-brand-accent",
  blocked: "text-brand-accent",
  review: "text-muted-foreground",
  parked: "text-muted-foreground",
  reference: "text-muted-foreground",
};

export interface AeStatusIconProps {
  status: AeStatus;
  className?: string;
}

export function AeStatusIcon({ status, className }: AeStatusIconProps) {
  const Icon = AE_STATUS_ICONS[status];
  const word = AE_STATUS_WORDS[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="ae-status-icon"
          data-status={status}
          role="img"
          aria-label={word}
          className={cn(
            "inline-flex shrink-0 items-center justify-center",
            TONES[status],
            className,
          )}
        >
          <Icon className="ui-icon" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{word}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The row form: derives the shown status from the conversation (blocked when a
 * working session has an approval prompt outstanding) and renders nothing for
 * a session with no `ae.status`, so the sidebar's edit stays one line.
 */
export function AeConversationStatusIcon({
  conversation,
  className,
}: {
  conversation: Pick<Conversation, "labels" | "pending_elicitations_count">;
  className?: string;
}) {
  const status = aeDisplayStatus(conversation);
  if (status === null) return null;
  return <AeStatusIcon status={status} className={className} />;
}
