// The action dock: what waits on the user in this chat (a question, a pull
// request ready to merge, a merge on its way to the box), inside the composer's
// workspace bar. The most urgent item sits after the folder and PR chips with
// its button, a badge per other kind sits before the bar's right cluster, and
// the caret opens a list as a tray above the bar (designs E1 and D3b). An item
// hides while its own card is on screen. Nothing waiting draws nothing.

import { QueryClientContext, useIsMutating, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ConfirmMerge, MERGED_TEXT } from "@/components/AePrCards";
import { COMPOSER_CONTENT_INSET_CLASS } from "@/components/composer/ChatComposer";
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
      <span className="min-w-0 truncate" title={item.text} data-ae-lead-text="">
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
        data-ae-lead-text=""
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

/**
 * Short of width, the badges drop to icon and count before the lead's text
 * truncates; they get their labels back once the lead has room for them.
 */
function useAeBadgeCompaction(
  leadRef: RefObject<HTMLDivElement | null>,
  badgesRef: RefObject<HTMLDivElement | null>,
  compact: boolean,
  setCompact: (compact: boolean) => void,
  layoutKey: string,
) {
  const fullWidth = useRef(0);
  // A different lead or badge set starts again from full labels; this runs
  // before paint, so the measure below re-compacts without a visible flip.
  useLayoutEffect(() => {
    setCompact(false);
  }, [layoutKey, setCompact]);
  useLayoutEffect(() => {
    const lead = leadRef.current;
    if (!lead) return;
    const measure = () => {
      const text = lead.querySelector<HTMLElement>("[data-ae-lead-text]");
      const badges = badgesRef.current;
      const truncated = Boolean(text && text.scrollWidth > text.clientWidth + 1);
      if (!compact) {
        if (badges && truncated) {
          fullWidth.current = badges.offsetWidth;
          setCompact(true);
        }
        return;
      }
      const saved = badges ? fullWidth.current - badges.offsetWidth : 0;
      const used = [...lead.children].reduce((w, c) => w + c.getBoundingClientRect().width, 0);
      if (!badges || (!truncated && lead.clientWidth - used > saved + 8)) setCompact(false);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(lead);
    // The lead's text changes without a resize ("merged 4m ago").
    const textObserver = new MutationObserver(measure);
    textObserver.observe(lead, { characterData: true, childList: true, subtree: true });
    return () => {
      observer.disconnect();
      textObserver.disconnect();
    };
  }, [leadRef, badgesRef, compact, setCompact, layoutKey]);
}

/** Nothing outside a query client (isolated composer tests render without one). */
export function AeActionDock({ sessionId }: { sessionId?: string }) {
  return useContext(QueryClientContext) ? <Dock sessionId={sessionId} /> : null;
}

function Dock({ sessionId }: { sessionId?: string }) {
  const onScreen = useAeCardsOnScreen();
  const { items, dismiss } = useAeActionDockItems(sessionId, onScreen);
  // Always starts closed: an open tray left over from an earlier visit would
  // cover the newest lines of the chat.
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<AeDockKind | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const badgesRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const openedForConfirm = useRef(false);
  const now = Date.now();
  useLayoutEffect(() => {
    if (!open || !scrollTo || !listRef.current) return;
    const line = listRef.current.querySelector<HTMLElement>(`[data-kind="${scrollTo}"]`);
    if (line) listRef.current.scrollTop = line.offsetTop;
    setScrollTo(null);
  }, [open, scrollTo]);
  // Escape closes the tray, and abandons a confirm in it.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      openedForConfirm.current = false;
      setConfirming(null);
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  // An open confirm scrolls into view inside the (taller) list, so Confirm is reachable.
  useLayoutEffect(() => {
    if (!open || !confirming) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-testid="ae-dock-confirm"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, confirming]);

  const summary = aeDockSummary(items);
  const confirmOpen = items.some((item) => item.key === confirming);
  // The item being confirmed went away (merged elsewhere, or its card came on
  // screen): drop the confirm, and the tray if it was opened only for it.
  useEffect(() => {
    if (!confirming || confirmOpen) return;
    setConfirming(null);
    if (openedForConfirm.current) setOpen(false);
    openedForConfirm.current = false;
  }, [confirming, confirmOpen]);
  useAeBadgeCompaction(
    leadRef,
    badgesRef,
    compact,
    setCompact,
    summary ? `${open}|${summary.lead.key}|${summary.badges.map((b) => b.label).join("|")}` : "",
  );
  if (!summary) return null;
  const toggle = (next: boolean, kind: AeDockKind | null = null) => {
    openedForConfirm.current = false;
    setConfirming(null);
    setOpen(next);
    setScrollTo(kind);
  };
  const confirmFor = (item: AeDockItem) =>
    item.kind === "merge" && confirming === item.key ? (
      <DockConfirm
        item={item}
        sessionId={sessionId}
        onDone={() => {
          setConfirming(null);
          // Opened only for the confirm: back to the strip, the saved choice untouched.
          if (openedForConfirm.current) setOpen(false);
          openedForConfirm.current = false;
        }}
      />
    ) : null;
  const actions = (item: AeDockItem) => (
    <ItemActions
      item={item}
      confirming={confirming === item.key}
      onMerge={() => {
        // The strip has no room for the confirm step: it opens in the list.
        if (!open) {
          openedForConfirm.current = true;
          setOpen(true);
          setConfirming(item.key);
          return;
        }
        setConfirming((key) => (key === item.key ? null : item.key));
      }}
      onDismiss={() => dismiss(item.anchor)}
    />
  );
  const { lead } = summary;
  const liveNotice = lead.kind === "deploy" && lead.deploy.state === "live";
  // Rendered inside the composer's workspace bar: `contents`, so each part is
  // one of the bar's own flex items (the caret goes last, after the bar's
  // right cluster). The list opens as a tray above the bar.
  return (
    <div
      data-testid="ae-action-dock"
      data-ae-dock-items=""
      data-ae-dock-open={open ? "" : undefined}
      role="region"
      aria-label={`Action dock: ${aeDockCountText(summary.total)}`}
      className="contents text-xs"
    >
      <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border md:mx-0" />
      <div
        ref={leadRef}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-xs md:gap-2"
        data-testid="ae-dock-lead"
      >
        {open ? (
          <span className="shrink-0 font-semibold">{aeDockCountText(summary.total)}</span>
        ) : (
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 md:gap-2",
              liveNotice && "h-6 rounded-md bg-emerald-500/15 pr-0.5 pl-1.5",
            )}
            data-testid={liveNotice ? "ae-dock-live" : undefined}
          >
            <ItemIcon item={lead} />
            <ItemBody item={lead} now={now} expanded={liveNotice} />
            {actions(lead)}
            {summary.more > 0 && (
              <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                +{summary.more}
                <span className="hidden md:inline"> more</span>
              </span>
            )}
          </span>
        )}
      </div>
      {!open && summary.badges.length > 0 && (
        <div ref={badgesRef} className="flex shrink-0 items-center gap-1 text-xs md:gap-1.5">
          {summary.badges.map((badge) => (
            <button
              key={badge.kind}
              type="button"
              className={cn(
                "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 whitespace-nowrap text-foreground hover:brightness-125",
                KIND_STYLE[badge.kind].tint,
              )}
              title={badge.label}
              onClick={() => toggle(true, badge.kind)}
              data-testid="ae-dock-badge"
              data-compact={compact ? "" : undefined}
            >
              <AeTablerSvg
                node={KIND_STYLE[badge.kind].icon}
                className={cn("size-3.5", KIND_STYLE[badge.kind].tone)}
              />
              <span className={cn("hidden", !compact && "md:inline")}>{badge.label}</span>
              <span className={cn("font-semibold", !compact && "md:hidden")}>{badge.count}</span>
            </button>
          ))}
        </div>
      )}
      {!liveNotice || open || summary.total > 1 ? (
        <span className="order-last flex shrink-0 items-center">
          <Caret open={open} total={summary.total} onClick={() => toggle(!open)} />
        </span>
      ) : null}
      {open && (
        <div
          className={cn(
            "composer-workspace-surface absolute -right-px bottom-full -left-px z-10 rounded-t-2xl border border-b-0 border-border pt-1",
            COMPOSER_CONTENT_INSET_CLASS,
          )}
          data-testid="ae-dock-tray"
        >
          <ul
            ref={listRef}
            className={cn(
              "relative",
              "overflow-y-auto overscroll-contain",
              // Four lines; a confirm gets up to half the screen to show whole.
              confirmOpen ? "max-h-[50vh]" : "max-h-[120px]",
            )}
            data-testid="ae-dock-list"
          >
            {items.map((item, index) => (
              <li
                key={item.key}
                data-kind={item.kind}
                className={cn(index > 0 && "border-t border-border/60")}
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
        </div>
      )}
    </div>
  );
}
