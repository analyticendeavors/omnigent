// Tests for the fast mode switch in the composer's model menu (omnigent-ae,
// 2026-10-14): shown for claude-native sessions only, turned on only on fast
// mode Opus releases and hosts that keep it per session, turned off from any
// state that may be on, pending until Claude Code confirms, reverted with the
// reason when a change is refused.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import {
  AE_FAST_MODE_CONFIRM_WINDOW_MS,
  AE_FAST_MODE_RECHECK_MS,
  resetAeFastModeStore,
} from "@/lib/aeFastMode";
import { useChatStore } from "@/store/chatStore";
import { AE_FAST_MODE_HINT, AE_FAST_MODE_NEEDS_PER_SESSION, AeFastModeSection } from "./AeFastMode";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));

const PATH = "/v1/sessions/conv-1/fast-mode";
const QUEUED = "Applies when the current reply finishes";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Answer GETs with `state`; PUTs go to `put` so a test can hold or fail them. */
function serve(
  state: boolean | null,
  put: (body: unknown) => Promise<Response>,
  perSession: boolean | null = true,
) {
  mocks.fetch.mockImplementation((_path: string, init: RequestInit) =>
    init.method === "PUT"
      ? put(JSON.parse(String(init.body)))
      : Promise.resolve(json(200, { enabled: state, per_session: perSession })),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderSection(
  props: Partial<Parameters<typeof AeFastModeSection>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <AeFastModeSection
          pickerKind="claude"
          model="claude-opus-5-5"
          modelLabel="Opus 5.5"
          {...props}
        />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

const fastSwitch = () => screen.getByRole("menuitemcheckbox", { name: "Fast mode" });
const note = () => screen.queryByTestId("composer-fast-mode-note");
const puts = () => mocks.fetch.mock.calls.filter(([, init]) => init.method === "PUT");
const reads = () => mocks.fetch.mock.calls.filter(([, init]) => init.method === "GET");
/** Let pending fetches and their state updates land. */
const settle = () => act(async () => {});

beforeEach(() => {
  mocks.fetch.mockReset();
  resetAeFastModeStore();
  useChatStore.setState({ conversationId: "conv-1", pendingModelChange: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AeFastModeSection", () => {
  it("shows for a claude-native session with its label and hint, and reads the state", async () => {
    serve(true, () => Promise.reject(new Error("no PUT expected")));
    renderSection();

    await waitFor(() => expect(fastSwitch()).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText(AE_FAST_MODE_HINT)).toHaveClass("sr-only");
    expect(fastSwitch()).toHaveAttribute("title", AE_FAST_MODE_HINT);
    expect(fastSwitch()).toHaveAccessibleDescription(AE_FAST_MODE_HINT);
    expect(note()).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledWith(PATH, { method: "GET" });
  });

  it.each(["codex", "cursor", "pi", null])("stays hidden for picker kind %s", (kind) => {
    serve(true, () => Promise.reject(new Error("no PUT expected")));
    renderSection({ pickerKind: kind });

    expect(screen.queryByTestId("composer-fast-mode")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("draws an unreported state off and says it is unknown", async () => {
    serve(null, () => Promise.reject(new Error("no PUT expected")));
    renderSection();

    await waitFor(() => expect(note()).toHaveTextContent("Unknown until the session replies"));
    expect(fastSwitch()).toHaveAttribute("aria-checked", "false");
    expect(fastSwitch()).not.toHaveAttribute("data-disabled");
  });

  it("shows no note while the first read runs", async () => {
    const answer = deferred<Response>();
    mocks.fetch.mockReturnValue(answer.promise);
    renderSection();

    expect(fastSwitch()).toHaveAttribute("aria-checked", "false");
    expect(note()).toBeNull();
    await act(async () => answer.resolve(json(200, { enabled: null })));
    expect(note()).toHaveTextContent("Unknown until the session replies");
  });

  it("treats a failed read as unknown", async () => {
    mocks.fetch.mockResolvedValue(json(503, { error: { message: "runner asleep" } }));
    renderSection();

    await waitFor(() => expect(note()).toHaveTextContent("Unknown until the session replies"));
    expect(fastSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it.each([
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-haiku-4-5", "Haiku 4.5"],
    ["claude-opus-4-1", "Opus 4.1"],
    [null, null],
  ])("cannot be turned on on %s, and says why", async (model, modelLabel) => {
    serve(false, () => Promise.resolve(json(200, { enabled: true })));
    renderSection({ model, modelLabel });

    await waitFor(() => expect(note()).toHaveTextContent("Choose a supported Opus model"));
    expect(fastSwitch()).toHaveAttribute("data-disabled");
    fireEvent.click(fastSwitch());
    expect(puts()).toHaveLength(0);
  });

  it.each([
    ["on", true],
    ["unknown", null],
  ])("can be turned off on a model without fast mode while %s", async (_label, state) => {
    serve(state, () => Promise.resolve(json(200, { enabled: false })));
    renderSection({ model: "claude-sonnet-5", modelLabel: "Sonnet 5" });
    await waitFor(() => expect(note()).toHaveTextContent("Choose a supported Opus model"));
    expect(fastSwitch()).toHaveAttribute("aria-checked", state ? "true" : "false");
    expect(fastSwitch()).not.toHaveAttribute("data-disabled");

    fireEvent.click(fastSwitch());

    expect(puts().map(([, init]) => JSON.parse(String(init.body)))).toEqual([{ enabled: false }]);
    await waitFor(() => expect(fastSwitch()).toHaveAttribute("data-disabled"));
    expect(fastSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("cannot be turned on where the host does not keep fast mode per session", async () => {
    serve(false, () => Promise.resolve(json(200, { enabled: true })), false);
    renderSection();

    await waitFor(() => expect(note()).toHaveTextContent(AE_FAST_MODE_NEEDS_PER_SESSION));
    expect(AE_FAST_MODE_NEEDS_PER_SESSION).toBe("Needs per-session fast mode on this host");
    expect(note()).toHaveClass("text-muted-foreground");
    expect(fastSwitch()).toHaveAttribute("data-disabled");
    fireEvent.click(fastSwitch());
    expect(puts()).toHaveLength(0);
  });

  it("can still be turned off where the host does not keep fast mode per session", async () => {
    serve(true, () => Promise.resolve(json(200, { enabled: false })), false);
    renderSection();
    await waitFor(() => expect(note()).toHaveTextContent(AE_FAST_MODE_NEEDS_PER_SESSION));
    expect(fastSwitch()).not.toHaveAttribute("data-disabled");

    fireEvent.click(fastSwitch());

    expect(puts().map(([, init]) => JSON.parse(String(init.body)))).toEqual([{ enabled: false }]);
  });

  it.each([
    ["claude-opus-5-5[1m]", null],
    ["claude-opus-5", null],
    ["claude-opus-4-8", null],
    ["opus", "Opus 4.8 (1M context)"],
  ])("is usable on %s", async (model, modelLabel) => {
    serve(false, () => Promise.resolve(json(200, { enabled: true })));
    renderSection({ model, modelLabel });

    await waitFor(() => expect(fastSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(fastSwitch()).not.toHaveAttribute("data-disabled");
    expect(note()).toBeNull();
  });

  it("is disabled while another configuration change runs", async () => {
    serve(false, () => Promise.resolve(json(200, { enabled: true })));
    renderSection({ busy: true });

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    expect(fastSwitch()).toHaveAttribute("data-disabled");
    useChatStore.setState({ pendingModelChange: "claude-opus-4-8" });
    cleanup();
    renderSection();
    expect(fastSwitch()).toHaveAttribute("data-disabled");
  });

  it("is pending while the terminal confirms, then shows the confirmed state", async () => {
    const answer = deferred<Response>();
    const sent: unknown[] = [];
    serve(false, (body) => {
      sent.push(body);
      return answer.promise;
    });
    renderSection();
    await waitFor(() => expect(fastSwitch()).toHaveAttribute("aria-checked", "false"));

    fireEvent.click(fastSwitch());

    expect(fastSwitch()).toHaveAttribute("aria-checked", "true");
    expect(fastSwitch()).toHaveAttribute("data-disabled");
    expect(fastSwitch()).toHaveAttribute("aria-busy", "true");
    expect(note()).toHaveTextContent("Turning fast mode on…");
    expect(sent).toEqual([{ enabled: true }]);
    expect(puts()[0]).toEqual([
      PATH,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    ]);
    // The menu stays open so the result is seen where it was asked for.
    expect(screen.getByTestId("composer-fast-mode")).toBeInTheDocument();

    await act(async () => answer.resolve(json(200, { enabled: true })));

    expect(fastSwitch()).toHaveAttribute("aria-checked", "true");
    expect(fastSwitch()).not.toHaveAttribute("data-disabled");
    expect(note()).toBeNull();
  });

  it("turns it off the same way", async () => {
    serve(true, () => Promise.resolve(json(200, { enabled: false })));
    renderSection();
    await waitFor(() => expect(fastSwitch()).toHaveAttribute("aria-checked", "true"));

    fireEvent.click(fastSwitch());

    await waitFor(() => expect(fastSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(JSON.parse(String(puts()[0][1].body))).toEqual({ enabled: false });
  });

  it("reverts and says why when the change is refused", async () => {
    const reason =
      "Could not turn fast mode on: No Claude Code terminal right now; send the session a message first.";
    serve(false, () =>
      Promise.resolve(json(409, { error: { code: "conflict", message: reason } })),
    );
    renderSection();
    await waitFor(() => expect(fastSwitch()).toHaveAttribute("aria-checked", "false"));

    fireEvent.click(fastSwitch());

    await waitFor(() => expect(note()).toHaveTextContent(reason));
    expect(note()).toHaveClass("text-destructive");
    expect(fastSwitch()).toHaveAttribute("aria-checked", "false");
    expect(fastSwitch()).not.toHaveAttribute("data-disabled");
  });

  it("clears the failure once a read succeeds on the next open", async () => {
    serve(false, () => Promise.resolve(json(409, { error: { message: "No terminal." } })));
    renderSection();
    await waitFor(() => expect(fastSwitch()).toHaveAttribute("aria-checked", "false"));
    fireEvent.click(fastSwitch());
    await waitFor(() => expect(note()).toHaveTextContent("No terminal."));
    cleanup();

    renderSection();

    await waitFor(() => expect(note()).toBeNull());
    expect(reads()).toHaveLength(2);
  });

  it("keeps a running change pending when the menu opens again", async () => {
    const answer = deferred<Response>();
    serve(false, () => answer.promise);
    renderSection();
    await waitFor(() => expect(fastSwitch()).toHaveAttribute("aria-checked", "false"));
    fireEvent.click(fastSwitch());
    cleanup();

    renderSection();

    expect(note()).toHaveTextContent("Turning fast mode on…");
    // No read while the change runs: it would race the confirmation.
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await act(async () => answer.resolve(json(200, { enabled: true })));
    expect(fastSwitch()).toHaveAttribute("aria-checked", "true");
  });

  describe("a change Claude Code has not confirmed yet (202)", () => {
    let snapshot: boolean;

    beforeEach(() => {
      vi.useFakeTimers();
      snapshot = false;
      mocks.fetch.mockImplementation((_path: string, init: RequestInit) =>
        Promise.resolve(
          init.method === "PUT"
            ? json(202, { enabled: true, pending: true, reason: QUEUED })
            : json(200, { enabled: snapshot, per_session: true }),
        ),
      );
    });

    async function flipOn() {
      renderSection();
      await settle();
      expect(fastSwitch()).toHaveAttribute("aria-checked", "false");
      fireEvent.click(fastSwitch());
      await settle();
    }

    it("keeps the switch at the requested state with the reason, re-reading every 2 s", async () => {
      await flipOn();

      expect(fastSwitch()).toHaveAttribute("aria-checked", "true");
      expect(fastSwitch()).toHaveAttribute("data-disabled");
      expect(note()).toHaveTextContent(QUEUED);
      expect(note()).toHaveClass("text-muted-foreground");
      expect(reads()).toHaveLength(1);

      await act(() => vi.advanceTimersByTimeAsync(AE_FAST_MODE_RECHECK_MS));
      expect(reads()).toHaveLength(2);
      expect(note()).toHaveTextContent(QUEUED);

      snapshot = true;
      await act(() => vi.advanceTimersByTimeAsync(AE_FAST_MODE_RECHECK_MS));
      expect(reads()).toHaveLength(3);
      expect(fastSwitch()).toHaveAttribute("aria-checked", "true");
      expect(fastSwitch()).not.toHaveAttribute("data-disabled");
      expect(note()).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(AE_FAST_MODE_RECHECK_MS * 3));
      expect(reads()).toHaveLength(3);
    });

    it("takes the snapshot once 60 s pass without a confirmation", async () => {
      await flipOn();

      await act(() => vi.advanceTimersByTimeAsync(AE_FAST_MODE_CONFIRM_WINDOW_MS - 1));
      expect(note()).toHaveTextContent(QUEUED);
      await act(() => vi.advanceTimersByTimeAsync(AE_FAST_MODE_RECHECK_MS));

      expect(fastSwitch()).toHaveAttribute("aria-checked", "false");
      expect(fastSwitch()).not.toHaveAttribute("data-disabled");
      expect(note()).toBeNull();
      const count = reads().length;
      await act(() => vi.advanceTimersByTimeAsync(AE_FAST_MODE_RECHECK_MS * 3));
      expect(reads()).toHaveLength(count);
    });

    it("re-reads only while the menu is open, and again on the next open", async () => {
      await flipOn();
      cleanup();
      await act(() => vi.advanceTimersByTimeAsync(AE_FAST_MODE_RECHECK_MS * 3));
      expect(reads()).toHaveLength(1);

      snapshot = true;
      renderSection();
      await settle();

      expect(reads()).toHaveLength(2);
      expect(fastSwitch()).toHaveAttribute("aria-checked", "true");
      expect(note()).toBeNull();
    });
  });
});
