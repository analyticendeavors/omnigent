// The "Master chat" row, first in the sidebar's primary navigation (omnigent-ae, 2026-11-27):
// one click opens the owner's master chat (the `orchestrator` agent's session), creating it the
// first time, and a pill counts the sessions waiting on the owner. The row holds no slot.
// With the session known it is a real link to the chat page (middle click opens a tab); without
// it a click asks the server to create it (`openAeMasterChat`) and then navigates there.

import { useQueryClient } from "@tanstack/react-query";
import { MessagesSquareIcon } from "lucide-react";
import { type MouseEvent, useRef } from "react";
import { toast } from "sonner";
import { openAeMasterChat, refreshAeMasterChat, useAeMasterChat } from "@/lib/aeMasterChat";
import { AE_COUNT_PILL, AE_COUNT_PILL_QUIET } from "@/lib/aeCountPill";
import { useLocation, useNavigate } from "@/lib/routing";
import { cn } from "@/lib/utils";
import { PrimaryNavLink } from "@/shell/PrimaryNavLink";

export interface AeMasterChatRowProps {
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export function AeMasterChatRow({ onNavigate }: AeMasterChatRowProps) {
  const { sessionId, waiting } = useAeMasterChat();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pending = useRef(false);
  const path = sessionId ? `/c/${sessionId}` : "/";
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onNavigate?.(event);
    if (sessionId) return;
    // Not known yet: the link's own navigation is replaced by create-then-open.
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    openAeMasterChat()
      .then((id) => {
        void refreshAeMasterChat(queryClient);
        navigate(`/c/${id}`);
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Opening the master chat failed.");
      })
      .finally(() => {
        pending.current = false;
      });
  };
  return (
    <PrimaryNavLink
      to={path}
      label="Master chat"
      icon={MessagesSquareIcon}
      active={sessionId !== null && pathname === path}
      onClick={onClick}
      componentId="sidebar.ae_master_chat"
      testId="ae-master-chat-row"
      trailing={
        waiting ? (
          <span
            data-testid="ae-master-chat-count"
            aria-label={
              waiting === 1 ? "1 session waiting on you" : `${waiting} sessions waiting on you`
            }
            className={cn(AE_COUNT_PILL, AE_COUNT_PILL_QUIET)}
          >
            {waiting}
          </span>
        ) : null
      }
    />
  );
}
