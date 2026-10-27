// One prompt from a session this chat started, in the action dock's tray (omnigent-ae,
// 2026-10-27): the child's title, an open link to its chat, and the real approval card.
// The card is the one the transcript uses; its verdict goes to the child, because the
// store block carries the child as `targetSessionId` (chatStore.submitApproval). A tall
// prompt scrolls inside the tray's list.

import { ApprovalCard } from "@/components/blocks/ApprovalCard";
import { AE_ICON_HELP_CIRCLE } from "@/lib/aeActionDockIcons";
import type { AeDockChildPrompt } from "@/lib/aeActionDock";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { ElicitationBlock } from "@/lib/blocks";
import { Link, useLocation } from "@/lib/routing";
import { sessionNavigationSearch } from "@/lib/sessionNavigation";
import { useChatStore } from "@/store/chatStore";

export function AeDockChildPrompt({ item }: { item: AeDockChildPrompt }) {
  const block = useChatStore((s) =>
    s.blocks.find(
      (b): b is ElicitationBlock => b.type === "elicitation" && b.elicitationId === item.anchor,
    ),
  );
  const { search } = useLocation();
  if (!block) return null;
  return (
    <div className="pb-2" data-testid="ae-dock-child-prompt">
      <div className="flex h-[30px] min-w-0 items-center gap-2">
        <AeTablerSvg
          node={AE_ICON_HELP_CIRCLE}
          className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span className="min-w-0 truncate font-semibold" title={item.childTitle}>
          {item.childTitle || "A session this chat started"}
        </span>
        <span className="flex-1" />
        <Link
          to={{ pathname: `/c/${item.childId}`, search: sessionNavigationSearch(search) }}
          componentId="dock.child_prompt.open"
          className="shrink-0 text-muted-foreground hover:text-foreground hover:underline"
          data-testid="ae-dock-child-open"
        >
          Open chat
        </Link>
      </div>
      <ApprovalCard
        elicitationId={block.elicitationId}
        message={block.message}
        phase={block.phase}
        policyName={block.policyName}
        contentPreview={block.contentPreview}
        requestedSchema={block.requestedSchema}
        url={block.url}
        status={block.status}
        response={block.response}
        askUserQuestion={block.askUserQuestion}
        exitPlanMode={block.exitPlanMode}
        codexCommand={block.codexCommand}
        allowAllEdits={block.allowAllEdits}
        allowAutoMode={block.allowAutoMode}
        rememberScope={block.rememberScope}
        codexPersistModes={block.codexPersistModes}
        className="border-0 bg-transparent p-0"
      />
    </div>
  );
}
