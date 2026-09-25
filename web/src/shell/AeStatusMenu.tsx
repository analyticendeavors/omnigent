// The Status submenu on a sidebar session's action menu: the five `ae.status`
// values with the stored one checked. It writes what the Parking Lot page's
// status buttons write (omnigent-ae `capacity.ts`): one label through
// `PATCH /v1/sessions/{id}`. Parked is label-only there, so it is here; the
// labels PATCH does not consult the slot cap, so Working asks
// `GET /v1/ae/capacity` first and refuses at the limit (omnigent-ae patch P4).

import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CircleDotIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { AE_STATUS_ICONS, AE_STATUS_WORDS } from "@/components/AeStatusIcon";
import { showToast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Conversation } from "@/hooks/useConversations";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import {
  AE_STATUS_KEY,
  AE_STATUS_VALUES,
  type AeStatus,
  aeStatusOf,
  isAeSlot,
} from "@/lib/aeLabels";
import { readAeSlotLimit, rememberAeSlotLimit } from "@/lib/aeSlotLimit";
import { authenticatedFetch } from "@/lib/identity";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";

/** What each item writes, mirroring the Parking Lot page's button titles. */
export const AE_STATUS_HINTS: Record<AeStatus, string> = {
  working: "Set ae.status to working (takes a slot; refused when all slots are working)",
  blocked: "Set ae.status to blocked (waiting on someone; holds no slot)",
  review: "Set ae.status to review (the Parking Lot's Done)",
  parked:
    "Set ae.status to parked and free the slot. Label only: nothing is filed to the " +
    "task-store; file the note from the Parking Lot page's Park form",
  reference: "Set ae.status to reference (closed, lookup only; never takes a slot)",
};

// The subset of the sidebar's menu-component bundle this menu renders, typed
// structurally so both the dropdown and the context-menu families satisfy it.
interface AeMenuItemProps {
  children?: ReactNode;
  className?: string;
  textValue?: string;
  role?: string;
  "aria-checked"?: boolean;
  onSelect?: (event: Event) => void;
  "data-testid"?: string;
  "data-status"?: string;
}

export interface AeMenuComponents {
  Item: ComponentType<AeMenuItemProps>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{
    children?: ReactNode;
    className?: string;
    "data-testid"?: string;
  }>;
  SubContent: ComponentType<{ children?: ReactNode; className?: string }>;
}

type Row = Pick<Conversation, "id" | "labels">;

// ── the write ────────────────────────────────────────────────────────────

/** A failed response as one sentence: the status line plus the server's `detail`. */
async function describeFailure(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
    else if (body.detail !== undefined) detail = JSON.stringify(body.detail);
  } catch {
    // No JSON body; the status line is all there is.
  }
  const status = `${res.status} ${res.statusText}`.trim();
  return detail ? `${status}: ${detail}` : status;
}

/** Write `ae.status` through upstream's labels PATCH; throws with the server's answer. */
export async function patchAeStatus(sessionId: string, status: AeStatus): Promise<void> {
  const res = await authenticatedFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: { [AE_STATUS_KEY]: status } }),
  });
  if (!res.ok) throw new Error(await describeFailure(res));
}

// ── the slot check ───────────────────────────────────────────────────────

export type AeSlotRoom =
  | { ok: true }
  | { ok: false; used: number; limit: number; titles: string[]; source: "server" | "sidebar" };

interface CapacityRow {
  id: string;
  title?: string | null;
}

interface CapacityAnswer {
  limit?: unknown;
  slots_used?: number;
  working?: CapacityRow[];
}

function cachedRows(queryClient: QueryClient): Conversation[] {
  const rows: Conversation[] = [];
  for (const [, data] of queryClient.getQueriesData<ConversationsInfiniteData>({
    queryKey: ["conversations"],
  })) {
    for (const page of data?.pages ?? []) rows.push(...page.data);
  }
  return rows;
}

/**
 * Whether `sessionId` may become working: the server's `/v1/ae/capacity`
 * count when it answers, else the sidebar cache's (each session once).
 */
export async function checkAeSlotRoom(
  queryClient: QueryClient,
  sessionId: string,
): Promise<AeSlotRoom> {
  try {
    const res = await authenticatedFetch("/v1/ae/capacity", { method: "GET" });
    if (res.ok) {
      const answer = (await res.json()) as CapacityAnswer;
      const working = (answer.working ?? []).filter((row) => row.id !== sessionId);
      const limit = rememberAeSlotLimit(queryClient, answer.limit) ?? readAeSlotLimit(queryClient);
      const used = working.length;
      if (used < limit) return { ok: true };
      return {
        ok: false,
        used,
        limit,
        titles: working.map((row) => row.title || row.id),
        source: "server",
      };
    }
  } catch {
    // Fall through to the sidebar's own count.
  }
  const seen = new Set<string>([sessionId]);
  const working: Conversation[] = [];
  for (const row of cachedRows(queryClient)) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (isAeSlot(row)) working.push(row);
  }
  const limit = readAeSlotLimit(queryClient);
  if (working.length < limit) return { ok: true };
  return {
    ok: false,
    used: working.length,
    limit,
    titles: working.map((row) => row.title || row.id),
    source: "sidebar",
  };
}

/** The refusal as the toast shows it: the count, who holds the slots, the way out. */
export function slotsFullMessage(room: Extract<AeSlotRoom, { ok: false }>): string {
  const who = room.titles.length > 0 ? ` (${room.titles.join(", ")})` : "";
  const counted = room.source === "server" ? "" : " by the sidebar's count";
  return (
    `Status not changed: all ${room.limit} slots are working${counted}${who}. ` +
    `Park or finish one first, or start the next prompt in this session with ` +
    `"ride unparked" to run it as one more.`
  );
}

// ── the cache overlay ────────────────────────────────────────────────────

function withStatus<T extends Row>(row: T, status: AeStatus): T {
  return { ...row, labels: { ...(row.labels ?? {}), [AE_STATUS_KEY]: status } };
}

function overlayPages(
  data: ConversationsInfiniteData | undefined,
  id: string,
  status: AeStatus,
): ConversationsInfiniteData | undefined {
  if (!data || !data.pages.some((page) => page.data.some((row) => row.id === id))) return data;
  return {
    ...data,
    pages: data.pages.map((page) =>
      page.data.some((row) => row.id === id)
        ? { ...page, data: page.data.map((row) => (row.id === id ? withStatus(row, status) : row)) }
        : page,
    ),
  };
}

/**
 * Paint the new status onto every cached copy of the row (the flat lists, the
 * project folders, the pinned list, the pinned-row backfill), in place rather
 * than by refetch: upstream's pin and archive overlays explain why, since the
 * list route can lag a PATCH and an immediate refetch bounces the row back.
 * The server's push converges it afterwards.
 */
export function overlayAeStatusIntoCaches(
  queryClient: QueryClient,
  id: string,
  status: AeStatus,
): void {
  for (const queryKey of [["conversations"], ["project-sessions"]]) {
    for (const [key, data] of queryClient.getQueriesData<ConversationsInfiniteData>({
      queryKey,
    })) {
      const next = overlayPages(data, id, status);
      if (next !== data) queryClient.setQueryData(key, next);
    }
  }
  // `PINNED_CONVERSATIONS_KEY` in useConversations, spelled out so the sidebar
  // suites that mock that module need not stub one more export.
  queryClient.setQueryData<{ conversations: Conversation[] } | undefined>(
    ["pinned-conversations"],
    (old) =>
      old && old.conversations.some((row) => row.id === id)
        ? {
            ...old,
            conversations: old.conversations.map((row) =>
              row.id === id ? withStatus(row, status) : row,
            ),
          }
        : old,
  );
  queryClient.setQueryData<Conversation | null | undefined>(["conversation-backfill", id], (old) =>
    old ? withStatus(old, status) : old,
  );
}

// ── the action ───────────────────────────────────────────────────────────

/**
 * Set a session's `ae.status` the way the menu does: nothing when it already
 * holds that value, the slot check before working, the PATCH, then the
 * overlay. Every failure is a toast that says what failed and what to do.
 * Returns whether the label was written.
 */
export async function applyAeStatus(
  queryClient: QueryClient,
  conversation: Row,
  status: AeStatus,
): Promise<boolean> {
  if (aeStatusOf(conversation.labels) === status) return false;
  if (status === "working") {
    const room = await checkAeSlotRoom(queryClient, conversation.id);
    if (!room.ok) {
      showToast(slotsFullMessage(room));
      return false;
    }
  }
  try {
    await patchAeStatus(conversation.id, status);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    showToast(
      `Could not set the status to ${AE_STATUS_WORDS[status]}: ${reason}. ` +
        `Reload the page and try again, or set it from the Parking Lot page.`,
    );
    return false;
  }
  overlayAeStatusIntoCaches(queryClient, conversation.id, status);
  return true;
}

// ── the menu ─────────────────────────────────────────────────────────────

function StatusItems({
  components: C,
  conversation,
  onDone,
}: {
  components: AeMenuComponents;
  conversation: Row;
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const current = aeStatusOf(conversation.labels);
  return (
    <>
      {AE_STATUS_VALUES.map((status) => {
        const Icon = AE_STATUS_ICONS[status];
        const checked = current === status;
        return (
          <Tooltip key={status}>
            <TooltipTrigger asChild>
              <C.Item
                data-testid="ae-status-item"
                data-status={status}
                role="menuitemradio"
                aria-checked={checked}
                textValue={AE_STATUS_WORDS[status]}
                onSelect={() => {
                  onDone?.();
                  void applyAeStatus(queryClient, conversation, status);
                }}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                <span className="flex-1 text-left">{AE_STATUS_WORDS[status]}</span>
                {checked && (
                  <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                )}
              </C.Item>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-64">
              {AE_STATUS_HINTS[status]}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </>
  );
}

/**
 * The Status submenu: a side flyout on desktop; inline under a "Status"
 * heading on mobile, where the sidebar's menus have no room to fly out (the
 * same reason upstream swaps its project picker in place there).
 */
export function AeStatusMenu({
  components: C,
  conversation,
  onDone,
}: {
  components: AeMenuComponents;
  conversation: Row;
  onDone?: () => void;
}) {
  const isMobile = useIsMobileViewport();
  if (isMobile) {
    return (
      <>
        <p className="px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground">Status</p>
        <StatusItems components={C} conversation={conversation} onDone={onDone} />
      </>
    );
  }
  return (
    <C.Sub>
      <C.SubTrigger data-testid="ae-status-menu" className="whitespace-nowrap">
        <CircleDotIcon className="size-3.5" />
        Status
      </C.SubTrigger>
      <C.SubContent className="min-w-40">
        <StatusItems components={C} conversation={conversation} onDone={onDone} />
      </C.SubContent>
    </C.Sub>
  );
}
