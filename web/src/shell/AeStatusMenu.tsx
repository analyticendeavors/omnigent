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
import { aeIsHelper, familySlotChain, familySlotKey } from "@/lib/aeFamily";
import {
  readAeHelpersCount,
  readAeSlotLimit,
  rememberAeHelpersCount,
  rememberAeSlotLimit,
} from "@/lib/aeSlotLimit";
import { authenticatedFetch } from "@/lib/identity";
import type { ConversationsInfiniteData } from "@/lib/sessionListCache";
import { AeMenuFold } from "@/shell/AeMenuFold";

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

/**
 * Write `ae.status` through upstream's labels PATCH (`null` clears it, which an
 * empty value does there); throws with the server's answer.
 */
export async function patchAeStatus(sessionId: string, status: AeStatus | null): Promise<void> {
  const res = await authenticatedFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: { [AE_STATUS_KEY]: status ?? "" } }),
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
  /** The family it counts against (`/v1/ae/capacity`, 2026-10-23). */
  family?: string;
  /** Started by another session (`/v1/ae/capacity`, 2026-10-26). */
  helper?: boolean;
}

interface CapacityAnswer {
  limit?: unknown;
  helpers_count?: unknown;
  /** Whether the asked-about session is a helper (`?session=`, 2026-10-26). */
  own_helper?: boolean | null;
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
 * Whether `sessionId` joins a slot one of *held* already holds: its own family's
 * top, or any session above it, since the server may key the family by a top
 * the cache has not loaded.
 */
function ridesInHeldSlot(queryClient: QueryClient, sessionId: string, held: Set<string>): boolean {
  const rows = cachedRows(queryClient);
  const own = rows.find((row) => row.id === sessionId);
  if (!own) return false;
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  return [familySlotKey(own, byId), ...familySlotChain(own, byId)].some((id) => held.has(id));
}

/** Whether the session is a helper another one started (it holds no slot unless counted). */
function ownIsHelper(
  queryClient: QueryClient,
  sessionId: string,
  fromServer?: boolean | null,
): boolean {
  // The server knows rows the sidebar has not loaded; the cache covers an older server.
  if (typeof fromServer === "boolean") return fromServer;
  const rows = cachedRows(queryClient);
  const own = rows.find((row) => row.id === sessionId);
  return own !== undefined && aeIsHelper(own, new Map(rows.map((row) => [row.id, row] as const)));
}

/** A working row's helper flag: the server's, else the cached row's `ae.orch` (older server). */
function rowIsHelper(row: CapacityRow, cached: Map<string, Conversation>): boolean {
  if (typeof row.helper === "boolean") return row.helper;
  const own = cached.get(row.id);
  return own !== undefined && aeIsHelper(own, cached);
}

/** A session list row from the cache, for a write that starts from a drag. */
export function aeCachedRow(queryClient: QueryClient, id: string): Conversation | undefined {
  return cachedRows(queryClient).find((row) => row.id === id);
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
    const res = await authenticatedFetch(
      `/v1/ae/capacity?session=${encodeURIComponent(sessionId)}`,
      { method: "GET" },
    );
    if (res.ok) {
      const answer = (await res.json()) as CapacityAnswer;
      const working = (answer.working ?? []).filter((row) => row.id !== sessionId);
      const limit = rememberAeSlotLimit(queryClient, answer.limit) ?? readAeSlotLimit(queryClient);
      const helpers = rememberAeHelpersCount(queryClient, answer.helpers_count);
      // A lead holds one slot for its family (2026-10-23); a helper holds none unless
      // Settings counts helpers (2026-10-26).
      if (!helpers && ownIsHelper(queryClient, sessionId, answer.own_helper)) return { ok: true };
      const cachedById = new Map(cachedRows(queryClient).map((row) => [row.id, row] as const));
      const holding = working.filter((row) => helpers || !rowIsHelper(row, cachedById));
      // A family holds one slot (2026-10-23): joining one that works takes none. With
      // helpers counted each holds its own, so nothing rides.
      const families = new Set(holding.map((row) => (helpers ? row.id : (row.family ?? row.id))));
      const held = new Set([...families, ...working.map((row) => row.id)]);
      if (!helpers && ridesInHeldSlot(queryClient, sessionId, held)) return { ok: true };
      const used = families.size;
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
  const allRows = cachedRows(queryClient);
  const byId = new Map(allRows.map((row) => [row.id, row] as const));
  for (const row of allRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (isAeSlot(row)) working.push(row);
  }
  const limit = readAeSlotLimit(queryClient);
  const helpers = readAeHelpersCount(queryClient);
  if (!helpers && ownIsHelper(queryClient, sessionId)) return { ok: true };
  const families = new Set(
    working
      .filter((row) => helpers || !aeIsHelper(row, byId))
      .map((row) => (helpers ? row.id : familySlotKey(row, byId))),
  );
  const held = new Set([...families, ...working.map((row) => row.id)]);
  if (!helpers && ridesInHeldSlot(queryClient, sessionId, held)) return { ok: true };
  if (families.size < limit) return { ok: true };
  return {
    ok: false,
    used: families.size,
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

function withStatus<T extends Row>(row: T, status: AeStatus | null): T {
  const { [AE_STATUS_KEY]: _old, ...rest } = row.labels ?? {};
  return { ...row, labels: status ? { ...rest, [AE_STATUS_KEY]: status } : rest };
}

function overlayPages(
  data: ConversationsInfiniteData | undefined,
  id: string,
  status: AeStatus | null,
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
  status: AeStatus | null,
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
 * `null` clears the status (a drop into Triage's No status group). Returns
 * whether the label was written.
 */
export async function applyAeStatus(
  queryClient: QueryClient,
  conversation: Row,
  status: AeStatus | null,
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
      `Could not set the status to ${status ? AE_STATUS_WORDS[status] : "No status"}: ${reason}. ` +
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
 * The Status submenu: a side flyout on desktop; on mobile, where the sidebar's
 * menus have no room to fly out, one row showing the current status that folds
 * the items open under it, so the phone menu fits the screen.
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
    const current = aeStatusOf(conversation.labels);
    const CurrentIcon = current ? AE_STATUS_ICONS[current] : null;
    return (
      <AeMenuFold
        Item={C.Item}
        icon={<CircleDotIcon className="size-3.5" />}
        label="Status"
        value={
          current && CurrentIcon ? (
            <>
              {AE_STATUS_WORDS[current]}
              <CurrentIcon className="size-3.5" aria-hidden="true" />
            </>
          ) : null
        }
        testId="ae-status-menu"
      >
        <StatusItems components={C} conversation={conversation} onDone={onDone} />
      </AeMenuFold>
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
