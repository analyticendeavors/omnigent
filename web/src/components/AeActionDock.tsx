// The action dock: what waits on the user in this chat (a question, a pull
// request ready to merge or still open, a merge on its way to the box), inside the composer's
// workspace bar, and an account near its usage limit. The most urgent item sits after the folder and PR chips with
// its button, a badge per other kind sits before the bar's right cluster, and
// the caret opens a list as a tray above the bar (designs E1 and D3b). A question
// hides while its own card is on screen; every other item stays, wherever the
// feed is scrolled. Nothing waiting draws nothing.

import { QueryClientContext, useIsMutating, useQueryClient } from "@tanstack/react-query";
import {
  type RefObject,
  forwardRef,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ConfirmMerge, MERGED_TEXT } from "@/components/AePrCards";
import { AePrLinkHoverCard } from "@/components/AePrLinkHoverCard";
import { COMPOSER_CONTENT_INSET_CLASS } from "@/components/composer/ChatComposer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { showToast } from "@/components/ui/toast";
import { useAeActionDockItems, useAeQuestionsOnScreen } from "@/hooks/useAeActionDockItems";
import { useAeDockLift } from "@/hooks/useAeDockLift";
import { useAeMarkReady } from "@/hooks/useAeMarkReady";
import { useAeSwitchClaudeAccount } from "@/hooks/useAeSwitchClaudeAccount";
import { useAeUpdateBranch } from "@/hooks/useAeUpdateBranch";
import {
  type AeBranchUpdate,
  type AeDockDraft,
  type AeDockItem,
  type AeDockLimit,
  type AeDockKind,
  type AeDockWaiting,
  aeBranchUpdatePending,
  aeDeployText,
  aeDockCountText,
  aeDockSummary,
  aeDraftText,
  aeMergeText,
  aeWaitingText,
} from "@/lib/aeActionDock";
import {
  AE_ICON_ARROW_DOWN,
  AE_ICON_ARROWS_EXCHANGE,
  AE_ICON_CHEVRON_UP,
  AE_ICON_GAUGE,
  AE_ICON_HELP_CIRCLE,
  AE_ICON_MESSAGE_PLUS,
  AE_ICON_ROCKET,
  AE_ICON_SPARKLES,
  AE_ICON_USER_SHARE,
  AE_ICON_X,
} from "@/lib/aeActionDockIcons";
import { AE_ICON_CHEVRON_DOWN } from "@/lib/aeAgentsIcons";
import { AE_ICON_CHECK, AE_ICON_MERGE, AE_ICON_PR_DRAFT, AE_ICON_PR_OPEN } from "@/lib/aePrIcons";
import { aeLimitGateShort, aeLimitGateText } from "@/lib/aeLimitGate";
import { AE_ADMIN_CENTER_PATH } from "@/lib/aePrDeploy";
import type { AeReceiptTone } from "@/lib/aePrReceipt";
import { aeCiText } from "@/lib/aePrs";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import { Link, useNavigate } from "@/lib/routing";
import { cn } from "@/lib/utils";
import { useForkDialog } from "@/shell/ForkDialogContext";

const GREEN = "text-emerald-600 dark:text-emerald-400";
const AMBER = "text-amber-600 dark:text-amber-400";
const RED = "text-red-600 dark:text-red-400";
const BLUE = "text-blue-600 dark:text-blue-400";
const MUTED = "text-muted-foreground";

/** A waiting line's icon in its receipt's tone (only these four reach the dock). */
const WAITING_TONE: Partial<Record<AeReceiptTone, string>> = {
  amber: AMBER,
  red: RED,
  blue: BLUE,
  gray: MUTED,
};

const KIND_STYLE: Record<AeDockKind, { icon: AeTablerIconNode; tone: string; tint: string }> = {
  question: { icon: AE_ICON_HELP_CIRCLE, tone: AMBER, tint: "bg-amber-500/15" },
  limit: { icon: AE_ICON_GAUGE, tone: RED, tint: "bg-red-500/15" },
  merge: { icon: AE_ICON_PR_OPEN, tone: GREEN, tint: "bg-emerald-500/15" },
  draft: { icon: AE_ICON_PR_DRAFT, tone: MUTED, tint: "bg-muted" },
  waiting: { icon: AE_ICON_PR_OPEN, tone: AMBER, tint: "bg-amber-500/15" },
  deploy: { icon: AE_ICON_ROCKET, tone: MERGED_TEXT, tint: "bg-purple-500/15" },
};

const ACTION = "h-6 shrink-0 px-2 text-xs";

/** What the limit item's buttons do; ChatPage supplies the model menu opener. */
export interface AeLimitActions {
  onSwitchModel?: () => void;
  /** Moves this chat to the login in place (it restarts and resumes). */
  onSwitchAccount?: (account: string, label: string) => void;
  /** Copies this chat to another login (the fork dialog). */
  onCopyAccount?: () => void;
  /** A switch is running. */
  switching?: boolean;
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
  const tone = live
    ? GREEN
    : item.kind === "waiting"
      ? (WAITING_TONE[item.receipt.tone] ?? style.tone)
      : style.tone;
  return (
    <AeTablerSvg
      node={live ? AE_ICON_CHECK : style.icon}
      className={cn("size-3.5 shrink-0", tone)}
    />
  );
}

/** The words after the icon: the question, the limit, or the number and its state. */
function ItemBody({ item, now, expanded }: { item: AeDockItem; now: number; expanded: boolean }) {
  if (item.kind === "limit") {
    const text = aeLimitGateText(item.gate, now);
    return (
      <>
        <span
          className={cn("min-w-0 truncate", !expanded && "hidden md:inline")}
          title={text}
          data-ae-lead-text=""
        >
          {text}
        </span>
        {!expanded && (
          <span className="shrink-0 font-semibold whitespace-nowrap md:hidden" title={text}>
            {aeLimitGateShort(item.gate)}
          </span>
        )}
      </>
    );
  }
  if (item.kind === "question") {
    return (
      <span className="min-w-0 truncate" title={item.text} data-ae-lead-text="">
        {item.text}
      </span>
    );
  }
  const detail =
    item.kind === "deploy"
      ? aeDeployText(item, now)
      : item.kind === "waiting"
        ? expanded
          ? `${item.card.title} · ${aeWaitingText(item)}`
          : aeWaitingText(item)
        : expanded
          ? `${item.card.title} · ${item.kind === "draft" ? "draft · " : ""}${aeCiText(item.card.ci)}`
          : item.kind === "merge"
            ? aeMergeText(item)
            : aeDraftText(item);
  return (
    <>
      {/* The chat links' preview on hover; no title, which would show over it. */}
      <AePrLinkHoverCard href={item.url} side="top">
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-semibold hover:underline"
          aria-label={`Open ${item.repo} #${item.number} on GitHub`}
          data-testid="ae-dock-pr-link"
        >
          #{item.number}
        </a>
      </AePrLinkHoverCard>
      {/* A phone drops the detail beside a button that names the state; a waiting line has no such button. */}
      <span
        className={cn(
          "min-w-0 truncate text-muted-foreground",
          !expanded && item.kind !== "waiting" && "hidden md:inline",
        )}
        title={detail}
        data-ae-lead-text=""
      >
        {detail}
      </span>
    </>
  );
}

function DismissButton({
  label,
  onClick,
  className = "flex",
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid="ae-dock-dismiss"
    >
      <AeTablerSvg node={AE_ICON_X} className="size-3.5" />
    </button>
  );
}

/**
 * Icon and label from md up, the icon alone on a phone. The strip shows the
 * short label so the limit's own words keep their room; the list the full one.
 */
/** Its own component so only a shown limit item needs a router (composer tests render without one). */
function NewChatButton({ inList }: { inList: boolean }) {
  const navigate = useNavigate();
  return (
    <LimitButton
      icon={AE_ICON_MESSAGE_PLUS}
      label="New chat"
      short="New chat"
      inList={inList}
      onClick={() => navigate("/")}
      testId="ae-dock-limit-new"
    />
  );
}

const LimitButton = forwardRef<
  HTMLButtonElement,
  {
    icon: AeTablerIconNode;
    label: string;
    short: string;
    inList: boolean;
    onClick?: () => void;
    testId: string;
    title?: string;
    disabled?: boolean;
  }
>(function LimitButton({ icon, label, short, inList, onClick, testId, title, ...rest }, ref) {
  return (
    <Button
      ref={ref}
      variant="outline"
      className={cn(ACTION, "w-6 px-0 md:w-auto md:px-2")}
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      data-testid={testId}
      {...rest}
    >
      <AeTablerSvg node={icon} className="size-3" />
      <span className="hidden md:inline">{inList ? label : short}</span>
    </Button>
  );
});

/** Switch this chat's login in place: one button for one other login, else a menu of them. */
function SwitchAccountButton({
  item,
  limitActions,
  inList,
}: {
  item: AeDockLimit;
  limitActions: AeLimitActions;
  inList: boolean;
}) {
  const { accountChoices } = item;
  const switchTo = limitActions.onSwitchAccount;
  if (!switchTo || accountChoices.length === 0) return null;
  const common = {
    icon: AE_ICON_ARROWS_EXCHANGE,
    label: "Switch account",
    short: "Account",
    inList,
    testId: "ae-dock-limit-account",
    disabled: limitActions.switching,
  };
  if (accountChoices.length === 1) {
    const [only] = accountChoices;
    return (
      <LimitButton
        {...common}
        title={`Restart this chat on ${only.label} and resume it. The next reply re-reads the conversation (extra tokens).`}
        onClick={() => switchTo(only.account, only.label)}
      />
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <LimitButton
          {...common}
          title="Restart this chat on another login and resume it. The next reply re-reads the conversation (extra tokens)."
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="ae-dock-limit-account-menu">
        {accountChoices.map((choice) => (
          <DropdownMenuItem
            key={choice.account}
            onSelect={() => switchTo(choice.account, choice.label)}
            data-testid={`ae-dock-limit-account-${choice.account || "default"}`}
          >
            {choice.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemActions({
  item,
  confirming,
  onMerge,
  onDismiss,
  limitActions,
  inList,
}: {
  item: AeDockItem;
  confirming: boolean;
  onMerge: () => void;
  onDismiss: () => void;
  limitActions: AeLimitActions;
  /** A line of the opened list, not the strip. */
  inList: boolean;
}) {
  switch (item.kind) {
    case "limit":
      return (
        <>
          {limitActions.onSwitchModel && (
            <LimitButton
              icon={AE_ICON_SPARKLES}
              label="Switch model"
              short="Model"
              inList={inList}
              onClick={limitActions.onSwitchModel}
              testId="ae-dock-limit-model"
            />
          )}
          {item.canSwitchAccount && (
            <SwitchAccountButton item={item} limitActions={limitActions} inList={inList} />
          )}
          {item.canCopyAccount && limitActions.onCopyAccount && (
            <LimitButton
              icon={AE_ICON_USER_SHARE}
              label="Copy to another login"
              short="Copy"
              inList={inList}
              title="Fork this chat, history included, onto another login. This chat stays where it is."
              onClick={limitActions.onCopyAccount}
              testId="ae-dock-limit-copy"
            />
          )}
          <NewChatButton inList={inList} />
          {/* A phone strip has no room for it; the opened list has. */}
          <DismissButton
            label="Dismiss until this limit resets"
            onClick={onDismiss}
            className={inList ? "flex" : "hidden md:flex"}
          />
        </>
      );
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
    case "draft":
      return <MarkReadyButton item={item} />;
    case "waiting":
      // The one thing a waiting pull request can take from here; the rest waits on checks or people.
      return item.card.update_branch?.allowed ? <UpdateBranchButton item={item} /> : null;
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
          <DismissButton label={`Dismiss #${item.number}`} onClick={onDismiss} />
        </>
      );
  }
}

/** The card's "Mark ready for review"; marking ready never merges, so no confirm step. */
function MarkReadyButton({ item }: { item: AeDockDraft }) {
  const ready = useAeMarkReady(item.card);
  const failed = ready.isError
    ? `Could not mark #${item.number} ready: ${ready.error.message}`
    : null;
  return (
    <Button
      variant="outline"
      className={cn(ACTION, failed && RED)}
      disabled={ready.busy || !item.card.head_sha}
      onClick={() => ready.mutate()}
      title={failed ?? `Mark #${item.number} ready for review`}
      aria-label={failed ?? `Mark #${item.number} ready for review`}
      data-testid="ae-dock-ready"
    >
      {/* A phone shows no title, so a failure changes the label too. */}
      {ready.busy ? "Marking…" : failed ? "Failed, retry" : "Mark ready"}
    </Button>
  );
}

/** The card's Update branch: merges the base into the head, so no confirm step either. */
function UpdateBranchButton({ item }: { item: AeDockWaiting }) {
  const update = useAeUpdateBranch(item.card);
  const failed = update.isError
    ? `Could not update #${item.number}: ${update.error.message}`
    : null;
  const label = failed ?? `Merge ${item.card.base_ref ?? "the base"} into #${item.number}'s branch`;
  return (
    <Button
      variant="outline"
      className={cn(ACTION, failed && RED)}
      disabled={update.waiting || !item.card.head_sha}
      onClick={() => update.mutate()}
      title={label}
      aria-label={label}
      data-testid="ae-dock-update"
    >
      {update.waiting ? "Updating…" : failed ? "Failed, retry" : "Update branch"}
    </Button>
  );
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
  // A stale entry (head already moved, no card mounted to clear it) must not block Confirm.
  const updateWaiting =
    updating ||
    aeBranchUpdatePending(
      queryClient.getQueryData<AeBranchUpdate>(updateKey),
      item.card.head_sha,
      Date.now(),
    );
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
export function AeActionDock({
  sessionId,
  onSwitchModel,
}: {
  sessionId?: string;
  /** Opens the composer's model menu (the limit item's Switch model). */
  onSwitchModel?: () => void;
}) {
  return useContext(QueryClientContext) ? (
    <Dock sessionId={sessionId} onSwitchModel={onSwitchModel} />
  ) : null;
}

function Dock({ sessionId, onSwitchModel }: { sessionId?: string; onSwitchModel?: () => void }) {
  const forkDialog = useForkDialog();
  const switchAccount = useAeSwitchClaudeAccount(sessionId);
  const limitActions: AeLimitActions = {
    onSwitchModel,
    onSwitchAccount: (account, label) =>
      switchAccount.mutate(account, {
        onSuccess: () => showToast(`This chat now runs on ${label}.`),
        onError: (failure) => showToast(failure.message),
      }),
    switching: switchAccount.isPending,
    // A full clone of this session, history included; the dialog's account row picks the login.
    onCopyAccount: forkDialog ? () => forkDialog.openForkDialog() : undefined,
  };
  const questionsOnScreen = useAeQuestionsOnScreen();
  const { items, dismiss } = useAeActionDockItems(sessionId, questionsOnScreen);
  // Always starts closed: an open tray left over from an earlier visit would
  // cover the newest lines of the chat.
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<AeDockKind | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [tray, setTray] = useState<HTMLDivElement | null>(null);
  useAeDockLift(tray);
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
  const actions = (item: AeDockItem, inList: boolean) => (
    <ItemActions
      item={item}
      inList={inList}
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
      limitActions={limitActions}
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
            {actions(lead, false)}
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
          ref={setTray}
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
                  {actions(item, true)}
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
