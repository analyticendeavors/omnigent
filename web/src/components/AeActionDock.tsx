// The action dock: one line above the composer's workspace bar gathering what
// waits on the user in this chat (a question, a pull request ready to merge, a
// merge on its way to the box). Collapsed it shows the most urgent item with
// its button and a badge per other kind (design E1); opened, a line per item
// (D3b). An item hides while its own card is on screen. Nothing waiting draws
// nothing. Reid approved E1, D3b and D4 on 2026-10-20. omnigent-ae.

import { QueryClientContext, useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import { ConfirmMerge, MERGED_TEXT } from "@/components/AePrCards";
import {
  COMPOSER_CONTENT_INSET_CLASS,
  COMPOSER_TRAY_INSET_CLASS,
} from "@/components/composer/ChatComposer";
import { Button } from "@/components/ui/button";
import { useAeActionDockItems, useAeCardsOnScreen } from "@/hooks/useAeActionDockItems";
import {
  type AeDockItem,
  type AeDockKind,
  aeDeployText,
  aeDockCountText,
  aeDockSummary,
  aeMergeText,
} from "@/lib/aeActionDock";
import {
  AE_ICON_ARROW_DOWN,
  AE_ICON_CHEVRON_UP,
  AE_ICON_HELP_CIRCLE,
  AE_ICON_ROCKET,
  AE_ICON_X,
} from "@/lib/aeActionDockIcons";
import { AE_ICON_CHEVRON_DOWN } from "@/lib/aeAgentsIcons";
import { AE_ICON_CHECK, AE_ICON_MERGE, AE_ICON_PR_OPEN } from "@/lib/aePrIcons";
import { AE_ADMIN_CENTER_PATH } from "@/lib/aePrDeploy";
import { aeCiText } from "@/lib/aePrs";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import { Link } from "@/lib/routing";
import { cn } from "@/lib/utils";

const GREEN = "text-emerald-600 dark:text-emerald-400";
const AMBER = "text-amber-600 dark:text-amber-400";

const KIND_STYLE: Record<AeDockKind, { icon: AeTablerIconNode; tone: string; tint: string }> = {
  question: { icon: AE_ICON_HELP_CIRCLE, tone: AMBER, tint: "bg-amber-500/15" },
  merge: { icon: AE_ICON_PR_OPEN, tone: GREEN, tint: "bg-emerald-500/15" },
  deploy: { icon: AE_ICON_ROCKET, tone: MERGED_TEXT, tint: "bg-purple-500/15" },
};

const ACTION = "h-6 shrink-0 px-2 text-xs";

function openKey(sessionId: string | undefined) {
  return `ae-action-dock:open:${sessionId ?? ""}`;
}

function readOpen(sessionId: string | undefined): boolean {
  try {
    return window.localStorage.getItem(openKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

function writeOpen(sessionId: string | undefined, open: boolean) {
  try {
    if (open) window.localStorage.setItem(openKey(sessionId), "1");
    else window.localStorage.removeItem(openKey(sessionId));
  } catch {
    // Storage off: the dock opens collapsed next time.
  }
}

/** Scroll the feed to the pending question's card. */
function jumpTo(anchor: string) {
  const card = [...document.querySelectorAll("[data-ae-question]")].find(
    (el) => el.getAttribute("data-ae-question") === anchor,
  );
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function ItemIcon({ item }: { item: AeDockItem }) {
  const live = item.kind === "deploy" && item.deploy.state === "live";
  const style = KIND_STYLE[item.kind];
  return (
    <AeTablerSvg
      node={live ? AE_ICON_CHECK : style.icon}
      className={cn("size-3.5 shrink-0", live ? GREEN : style.tone)}
    />
  );
}

/** The words after the icon: the question, or the number and its state. */
function ItemBody({ item, now, expanded }: { item: AeDockItem; now: number; expanded: boolean }) {
  if (item.kind === "question") {
    return (
      <span className="min-w-0 truncate" title={item.text}>
        {item.text}
      </span>
    );
  }
  const detail =
    item.kind === "merge"
      ? expanded
        ? `${item.card.title} · ${aeCiText(item.card.ci)}`
        : aeMergeText(item)
      : aeDeployText(item, now);
  return (
    <>
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 font-semibold hover:underline"
        title={`Open ${item.repo} #${item.number} on GitHub`}
      >
        #{item.number}
      </a>
      <span
        className={cn("min-w-0 truncate text-muted-foreground", !expanded && "hidden md:inline")}
        title={detail}
      >
        {detail}
      </span>
    </>
  );
}

function ItemActions({
  item,
  confirming,
  onMerge,
  onDismiss,
}: {
  item: AeDockItem;
  confirming: boolean;
  onMerge: () => void;
  onDismiss: () => void;
}) {
  switch (item.kind) {
    case "question":
      return (
        <Button
          variant="outline"
          className={ACTION}
          onClick={() => jumpTo(item.anchor)}
          data-testid="ae-dock-jump"
        >
          Jump to it
          <AeTablerSvg node={AE_ICON_ARROW_DOWN} className="size-3" />
        </Button>
      );
    case "merge":
      return (
        <Button
          className={ACTION}
          aria-expanded={confirming}
          disabled={!item.card.merge.allowed}
          onClick={onMerge}
          title={`Merge #${item.number}`}
          data-testid="ae-dock-merge"
        >
          <AeTablerSvg node={AE_ICON_MERGE} className="size-3" />
          Merge
        </Button>
      );
    case "deploy":
      return (
        <>
          {item.deploy.state === "waiting" && (
            <Button variant="outline" className={ACTION} asChild>
              <Link to={AE_ADMIN_CENTER_PATH} title="Deploy hold in the Admin Center">
                Admin Center
              </Link>
            </Button>
          )}
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Dismiss #${item.number}`}
            onClick={onDismiss}
            data-testid="ae-dock-dismiss"
          >
            <AeTablerSvg node={AE_ICON_X} className="size-3.5" />
          </button>
        </>
      );
  }
}

/** The PR card's own confirm step (method choice, then Confirm), inside the dock. */
function DockConfirm({
  item,
  sessionId,
  onDone,
}: {
  item: Extract<AeDockItem, { kind: "merge" }>;
  sessionId?: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const updateKey = ["ae-pr-branch-update", item.repo, item.number] as const;
  const updating = useIsMutating({ mutationKey: updateKey }) > 0;
  const updateWaiting = updating || Boolean(queryClient.getQueryData(updateKey));
  return (
    <div className="@container/aepr pb-2" data-testid="ae-dock-confirm">
      <ConfirmMerge
        card={item.card}
        updateWaiting={updateWaiting}
        sessionId={sessionId}
        onCancel={onDone}
        onMerged={onDone}
      />
    </div>
  );
}

function Caret({ open, total, onClick }: { open: boolean; total: number; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-expanded={open}
      aria-label={open ? "Collapse the waiting list" : `Show all ${total} waiting`}
      onClick={onClick}
      data-testid="ae-dock-caret"
    >
      <AeTablerSvg node={open ? AE_ICON_CHEVRON_DOWN : AE_ICON_CHEVRON_UP} className="size-4" />
    </button>
  );
}

/** Nothing outside a query client (isolated composer tests render without one). */
export function AeActionDock({ sessionId }: { sessionId?: string }) {
  return useContext(QueryClientContext) ? <Dock sessionId={sessionId} /> : null;
}

function Dock({ sessionId }: { sessionId?: string }) {
  const onScreen = useAeCardsOnScreen();
  const { items, dismiss } = useAeActionDockItems(sessionId, onScreen);
  const [open, setOpen] = useState(() => readOpen(sessionId));
  const [confirming, setConfirming] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<AeDockKind | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const now = Date.now();
  useLayoutEffect(() => {
    if (!open || !scrollTo || !listRef.current) return;
    const line = listRef.current.querySelector<HTMLElement>(`[data-kind="${scrollTo}"]`);
    if (line) listRef.current.scrollTop = line.offsetTop;
    setScrollTo(null);
  }, [open, scrollTo]);

  const summary = aeDockSummary(items);
  if (!summary) return null;
  const toggle = (next: boolean, kind: AeDockKind | null = null) => {
    setOpen(next);
    writeOpen(sessionId, next);
    setScrollTo(kind);
  };
  const confirmFor = (item: AeDockItem) =>
    item.kind === "merge" && confirming === item.key ? (
      <DockConfirm item={item} sessionId={sessionId} onDone={() => setConfirming(null)} />
    ) : null;
  const actions = (item: AeDockItem) => (
    <ItemActions
      item={item}
      confirming={confirming === item.key}
      onMerge={() => setConfirming((key) => (key === item.key ? null : item.key))}
      onDismiss={() => dismiss(item.anchor)}
    />
  );
  const { lead } = summary;
  return (
    <div
      data-testid="ae-action-dock"
      role="region"
      aria-label={`Action dock: ${aeDockCountText(summary.total)}`}
      className={cn(
        "composer-workspace-surface relative z-0 -mb-px flex min-w-0 flex-col rounded-t-2xl border border-b-0 border-border text-xs",
        COMPOSER_CONTENT_INSET_CLASS,
        COMPOSER_TRAY_INSET_CLASS,
        // Square the workspace bar's top below, and its own top under a tray.
        "[&+.composer-workspace-surface]:rounded-t-none",
        "[:is(.composer-queued-surface,.composer-subagent-surface)+&]:rounded-t-none",
      )}
    >
      {open ? (
        <>
          <div className="flex h-7 items-center gap-2">
            <span className="font-semibold">{aeDockCountText(summary.total)}</span>
            <span className="flex-1" />
            <Caret open total={summary.total} onClick={() => toggle(false)} />
          </div>
          <ul
            ref={listRef}
            className="relative max-h-[120px] overflow-y-auto overscroll-contain"
            data-testid="ae-dock-list"
          >
            {items.map((item) => (
              <li
                key={item.key}
                data-kind={item.kind}
                className="border-t border-border/60"
                data-testid="ae-dock-line"
              >
                <div className="flex h-[30px] min-w-0 items-center gap-2">
                  <ItemIcon item={item} />
                  <ItemBody item={item} now={now} expanded />
                  <span className="flex-1" />
                  {actions(item)}
                </div>
                {confirmFor(item)}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="flex h-8 min-w-0 items-center gap-2" data-testid="ae-dock-lead">
            <ItemIcon item={lead} />
            <ItemBody item={lead} now={now} expanded={false} />
            {actions(lead)}
            {summary.more > 0 && (
              <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                +{summary.more} more
              </span>
            )}
            <span className="flex-1" />
            {summary.badges.map((badge) => (
              <button
                key={badge.kind}
                type="button"
                className={cn(
                  "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 whitespace-nowrap text-foreground hover:brightness-125",
                  KIND_STYLE[badge.kind].tint,
                )}
                title={badge.label}
                onClick={() => toggle(true, badge.kind)}
                data-testid="ae-dock-badge"
              >
                <AeTablerSvg
                  node={KIND_STYLE[badge.kind].icon}
                  className={cn("size-3.5", KIND_STYLE[badge.kind].tone)}
                />
                <span className="hidden md:inline">{badge.label}</span>
                <span className="font-semibold md:hidden">{badge.count}</span>
              </button>
            ))}
            <Caret open={false} total={summary.total} onClick={() => toggle(true)} />
          </div>
          {confirmFor(lead)}
        </>
      )}
    </div>
  );
}
