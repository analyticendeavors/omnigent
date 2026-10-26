// Pin a lead's family (omnigent-ae, 2026-10-26):
//   1. Setting off: the single toggle runs, with no read.
//   2. On: pinning a lead pins it and its open sessions, lead first; reference,
//      archived and already pinned sessions are left alone.
//   3. On: a family that needs more pin spots than are free pins nothing and says so.
//   4. On: unpinning the lead unpins every pinned session of the family, with one Undo
//      that re-pins them at their old values.
//   5. On: a session started by another, or one that leads nothing, toggles alone.
//   6. A failed read changes nothing and says so; a double click reads once.
//   7. Without shared pins, only the viewer's sessions count and get pinned.
//   8. A member the sidebar has not loaded is seeded into the cache before its pin.

import { QueryClient } from "@tanstack/react-query";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConversationsModule from "@/hooks/useConversations";
import { PINNED_CONVERSATIONS_KEY, type Conversation } from "@/hooks/useConversations";
import { writeAePinFamily } from "@/lib/aePinFamily";
import { PINNED_LABEL_KEY } from "@/lib/sessionListCache";

const mocks = vi.hoisted(() => ({ read: vi.fn(), toast: vi.fn(), showToast: vi.fn() }));

vi.mock("@/hooks/useConversations", async (importOriginal) => ({
  ...(await importOriginal<typeof ConversationsModule>()),
  fetchConversationsPage: mocks.read,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/components/ui/toast", () => ({ showToast: mocks.showToast }));
vi.mock("@/lib/identity", () => ({ getCurrentUserId: () => "me@example.com" }));

import { aeTogglePinFamily, resetAePinFamilyForTests } from "./aePinFamily";

function session(
  id: string,
  labels: Record<string, string> = {},
  extra: Partial<Conversation> = {},
) {
  return {
    id,
    object: "conversation",
    title: id,
    created_at: 0,
    updated_at: 0,
    labels,
    permission_level: null,
    status: "idle",
    ...extra,
  } as Conversation;
}

const LEAD = session("lead");
const child = (id: string, status = "working", parent = "lead") =>
  session(id, { "ae.orch": parent, "ae.status": status });

let queryClient: QueryClient;
type WritePin = (vars: { id: string; pinned: boolean; pinnedAt?: number }) => Promise<unknown>;
let writePin: Mock<WritePin>;
let alone: Mock<() => void>;

/** The session list the read returns: *open* rows, and *archived* ones. */
function sessionList(open: Conversation[], archived: Conversation[] = []) {
  mocks.read.mockImplementation(async ({ visibility }: { visibility?: string }) => ({
    data: visibility === "archived" ? archived : open,
    has_more: false,
    last_id: null,
  }));
}

/** Sessions pinned now, with their pin values. */
function pinned(pins: Record<string, number>) {
  queryClient.setQueryData(PINNED_CONVERSATIONS_KEY, {
    conversations: Object.entries(pins).map(([id, at]) =>
      session(id, { [PINNED_LABEL_KEY]: String(at) }),
    ),
    filterHonored: true,
  });
}

function toggle(target: Conversation, isPinned: boolean, pinCap = 30, includeShared = true) {
  aeTogglePinFamily({
    queryClient,
    writePin,
    session: target,
    pinned: isPinned,
    pinCap,
    includeShared,
    alone,
  });
}

const settle = () =>
  vi
    .waitFor(() => expect(mocks.read).toHaveBeenCalled())
    .then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        }),
    );

beforeEach(() => {
  window.localStorage.clear();
  writeAePinFamily(true);
  resetAePinFamilyForTests();
  queryClient = new QueryClient();
  pinned({});
  writePin = vi.fn<WritePin>(() => Promise.resolve({}));
  alone = vi.fn<() => void>();
  mocks.read.mockReset();
  mocks.toast.mockReset();
  mocks.showToast.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("aeTogglePinFamily", () => {
  it("toggles alone, with no read, while the setting is off", () => {
    writeAePinFamily(false);
    sessionList([LEAD, child("a")]);
    toggle(LEAD, false);
    expect(alone).toHaveBeenCalledTimes(1);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(writePin).not.toHaveBeenCalled();
  });

  it("pins the lead, then its open sessions, and nothing closed or pinned already", async () => {
    sessionList(
      [LEAD, child("a"), child("b", "review"), child("ref", "reference"), child("c")],
      [session("old", { "ae.orch": "lead" }, { archived: true })],
    );
    pinned({ c: 5 });
    toggle(LEAD, false);
    await vi.waitFor(() => expect(writePin).toHaveBeenCalledTimes(3));
    expect(writePin.mock.calls.map(([w]) => w)).toEqual([
      { id: "lead", pinned: true },
      { id: "a", pinned: true },
      { id: "b", pinned: true },
    ]);
    expect(alone).not.toHaveBeenCalled();
  });

  it("pins a grandchild started by an open session", async () => {
    sessionList([LEAD, child("a"), child("g", "working", "a")]);
    toggle(LEAD, false);
    await vi.waitFor(() => expect(writePin).toHaveBeenCalledTimes(3));
    expect(writePin.mock.calls.map(([w]) => w.id)).toEqual(["lead", "a", "g"]);
  });

  it("pins nothing and says so when the family needs more spots than are free", async () => {
    sessionList([LEAD, child("a"), child("b")]);
    pinned({ x: 1, y: 2 });
    toggle(LEAD, false, 4);
    await settle();
    expect(writePin).not.toHaveBeenCalled();
    expect(alone).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(
      "Not enough pin spots for this family (3 needed, 2 free). Nothing was pinned.",
    );
  });

  it("stops at the first pin that fails and says how many saved", async () => {
    sessionList([LEAD, child("a"), child("b")]);
    writePin.mockImplementation(({ id }: { id: string }) =>
      id === "a" ? Promise.reject(new Error("refused")) : Promise.resolve({}),
    );
    toggle(LEAD, false);
    await settle();
    expect(writePin.mock.calls.map(([w]) => w.id)).toEqual(["lead", "a"]);
    expect(mocks.showToast).toHaveBeenCalledWith(
      "Pinned 1 of 3 family sessions; the rest did not save. Pin them again to retry.",
    );
  });

  it("does not pin the lead again when it was pinned while the family was read", async () => {
    sessionList([LEAD, child("a")]);
    mocks.read.mockImplementationOnce(async () => {
      pinned({ lead: 7 });
      return { data: [LEAD, child("a")], has_more: false, last_id: null };
    });
    toggle(LEAD, false);
    await vi.waitFor(() => expect(writePin).toHaveBeenCalledTimes(1));
    expect(writePin.mock.calls[0][0]).toEqual({ id: "a", pinned: true });
  });

  describe("without shared pins", () => {
    const theirs = (id: string, extra: Record<string, string> = {}) =>
      session(id, { [PINNED_LABEL_KEY]: "1", ...extra }, { owner: "other@example.com" });

    it("counts only the viewer's pins against the cap", async () => {
      sessionList([LEAD, child("a")]);
      queryClient.setQueryData(PINNED_CONVERSATIONS_KEY, {
        conversations: [session("x", { [PINNED_LABEL_KEY]: "1" }), theirs("s1"), theirs("s2")],
        filterHonored: true,
      });
      toggle(LEAD, false, 3, false);
      await vi.waitFor(() => expect(writePin).toHaveBeenCalledTimes(2));
      expect(mocks.showToast).not.toHaveBeenCalled();
    });

    it("leaves another person's session in the family unpinned", async () => {
      sessionList([
        LEAD,
        child("a"),
        session("s", { "ae.orch": "lead", "ae.status": "working" }, { owner: "other@example.com" }),
      ]);
      toggle(LEAD, false, 30, false);
      await vi.waitFor(() => expect(writePin).toHaveBeenCalledTimes(2));
      expect(writePin.mock.calls.map(([w]) => w.id)).toEqual(["lead", "a"]);
    });
  });

  it("seeds a member the sidebar has not loaded before pinning it", async () => {
    const far = child("far");
    sessionList([LEAD, far]);
    let seen: unknown;
    writePin.mockImplementation(({ id }: { id: string }) => {
      if (id === "far") seen = queryClient.getQueryData(["conversation-backfill", "far"]);
      return Promise.resolve({});
    });
    toggle(LEAD, false);
    await vi.waitFor(() => expect(writePin).toHaveBeenCalledTimes(2));
    expect(seen).toEqual(far);
  });

  it("toggles a loaded child alone, with no read, from its cached labels", () => {
    queryClient.setQueryData(["conversations", "x"], {
      pages: [{ data: [child("a")] }],
      pageParams: [undefined],
    });
    // The sidebar knows only the id of a row it has not pinned.
    toggle({ id: "a" } as Conversation, false);
    expect(alone).toHaveBeenCalledTimes(1);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("unpins the lead and every pinned family session, and Undo re-pins them where they were", async () => {
    sessionList([LEAD, child("a"), child("b"), child("ref", "reference")]);
    pinned({ lead: 10, a: 11, ref: 12 });
    toggle(LEAD, true);
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(writePin.mock.calls.map(([w]) => w)).toEqual([
      { id: "lead", pinned: false },
      { id: "a", pinned: false },
      { id: "ref", pinned: false },
    ]);
    const [title, opts] = mocks.toast.mock.calls[0];
    expect(title).toBe("Unpinned 3 sessions");
    writePin.mockClear();
    pinned({});
    opts.action.onClick();
    await vi.waitFor(() => expect(writePin).toHaveBeenCalledTimes(3));
    expect(writePin.mock.calls.map(([w]) => w)).toEqual([
      { id: "lead", pinned: true, pinnedAt: 10 },
      { id: "a", pinned: true, pinnedAt: 11 },
      { id: "ref", pinned: true, pinnedAt: 12 },
    ]);
  });

  it("unpins alone when no other family session is pinned", async () => {
    sessionList([LEAD, child("a")]);
    pinned({ lead: 10 });
    toggle(LEAD, true);
    await settle();
    expect(alone).toHaveBeenCalledTimes(1);
    expect(writePin).not.toHaveBeenCalled();
  });

  it("toggles a session started by another alone, with no read", () => {
    toggle(child("a"), false);
    expect(alone).toHaveBeenCalledTimes(1);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("toggles a session that leads nothing alone", async () => {
    sessionList([LEAD, session("other")]);
    toggle(LEAD, false);
    await settle();
    expect(alone).toHaveBeenCalledTimes(1);
    expect(writePin).not.toHaveBeenCalled();
  });

  it("pins the lead alone when every session under it is closed", async () => {
    sessionList([LEAD, child("ref", "reference")]);
    toggle(LEAD, false);
    await settle();
    expect(alone).toHaveBeenCalledTimes(1);
    expect(writePin).not.toHaveBeenCalled();
  });

  it("changes nothing and says so when the family can't be read", async () => {
    mocks.read.mockRejectedValue(new Error("offline"));
    toggle(LEAD, false);
    await settle();
    expect(alone).not.toHaveBeenCalled();
    expect(writePin).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(
      "Couldn't read the family's sessions, so nothing was pinned. Try again.",
    );
  });

  it("reads once for a double click", async () => {
    sessionList([LEAD, child("a")]);
    toggle(LEAD, false);
    toggle(LEAD, false);
    await vi.waitFor(() => expect(writePin).toHaveBeenCalledTimes(2));
    // Two slices per read: open and archived.
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
});
