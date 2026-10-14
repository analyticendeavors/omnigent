// Tests for the fast mode switch in the composer's model menu (omnigent-ae,
// 2026-10-14): shown for claude-native sessions only, usable on fast mode
// Opus releases only, pending while the terminal confirms, reverted with the
// reason when it does not.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { resetAeFastModeStore } from "@/lib/aeFastMode";
import { useChatStore } from "@/store/chatStore";
import { AE_FAST_MODE_HINT, AeFastModeSection } from "./AeFastMode";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));

const PATH = "/v1/sessions/conv-1/fast-mode";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Answer GETs with `state`; PUTs go to `put` so a test can hold or fail them. */
function serve(state: boolean | null, put: (body: unknown) => Promise<Response>) {
  mocks.fetch.mockImplementation((_path: string, init: RequestInit) =>
    init.method === "PUT"
      ? put(JSON.parse(String(init.body)))
      : Promise.resolve(json(200, { enabled: state })),
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

beforeEach(() => {
  mocks.fetch.mockReset();
  resetAeFastModeStore();
  useChatStore.setState({ conversationId: "conv-1", pendingModelChange: null });
});
afterEach(cleanup);

describe("AeFastModeSection", () => {
  it("shows for a claude-native session with its label and hint, and reads the state", async () => {
    serve(true, () => Promise.reject(new Error("no PUT expected")));
    renderSection();

    await waitFor(() => expect(fastSwitch()).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText(AE_FAST_MODE_HINT)).toBeInTheDocument();
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
  ])("is disabled with the reason for %s", async (model, modelLabel) => {
    serve(false, () => Promise.resolve(json(200, { enabled: true })));
    renderSection({ model, modelLabel });

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    expect(fastSwitch()).toHaveAttribute("data-disabled");
    expect(note()).toHaveTextContent("Opus only");
    fireEvent.click(fastSwitch());
    expect(puts()).toHaveLength(0);
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

  it("reverts and says why when the terminal does not confirm", async () => {
    const reason =
      "Could not turn fast mode on: Claude Code did not confirm the change within 10s.";
    serve(false, () =>
      Promise.resolve(json(503, { error: { code: "runner_unavailable", message: reason } })),
    );
    renderSection();
    await waitFor(() => expect(fastSwitch()).toHaveAttribute("aria-checked", "false"));

    fireEvent.click(fastSwitch());

    await waitFor(() => expect(note()).toHaveTextContent(reason));
    expect(note()).toHaveClass("text-destructive");
    expect(fastSwitch()).toHaveAttribute("aria-checked", "false");
    expect(fastSwitch()).not.toHaveAttribute("data-disabled");
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
});
