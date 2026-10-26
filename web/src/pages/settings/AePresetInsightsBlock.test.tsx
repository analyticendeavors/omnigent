// Settings > Roles > Preset insights: the switch saves the insights setting and
// shows the task error, the rows appear only while it is on, Run now posts, and
// the user's own suggestions apply, undo and dismiss (409 message on the row).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AePresetSuggestion } from "@/hooks/useAePresetReview";
import type { AeRolesState } from "@/lib/aeRoles";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), showToast: vi.fn(), admin: { value: false } }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));
vi.mock("@/components/ui/toast", () => ({ showToast: mocks.showToast }));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsAdmin: () => mocks.admin.value }));

import { AePresetInsightsBlock, aeInsightsDay, aeOwnSuggestions } from "./AePresetInsightsBlock";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stateOf(patch: Partial<AeRolesState> = {}): AeRolesState {
  return {
    revision: 3,
    default_preset: "balanced",
    apply_start_on: true,
    presets: [],
    starters: [],
    ...patch,
  };
}

const ON = { enabled: true, weeks: 2, scope: "all" as const };

function suggestion(patch: Partial<AePresetSuggestion> = {}): AePresetSuggestion {
  return {
    id: "sg_1",
    review_id: "rv_1",
    kind: "own",
    preset_title: "Deep debug",
    title: "Builder Opus high to Sonnet high",
    why: "There were 14 runs.",
    saving: "about $5 per run",
    status: "open",
    can_apply: true,
    can_undo: false,
    ...patch,
  };
}

const STATUS = {
  enabled: true,
  scope: "all",
  task: { id: "t1", state: "active", next_run_at: "2026-11-03T07:00:00Z" },
  last_review: "2026-10-20T07:30:00Z",
  next_review: "2026-11-03T07:00:00Z",
  reviewer: { model: "claude-opus-5-5", effort: "high", preset_title: "Balanced" },
  open: 1,
};

interface Routes {
  suggestions?: AePresetSuggestion[];
  put?: (body: AeRolesState) => Response;
  post?: Record<string, Response>;
  status?: () => typeof STATUS;
}

function serve({ suggestions = [suggestion()], put, post = {}, status }: Routes = {}) {
  const calls: { url: string; method: string; body: string }[] = [];
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: String(init?.body ?? "") });
    if (url === "/v1/ae/preset-review" && method === "GET") return json(status ? status() : STATUS);
    if (url === "/v1/ae/preset-suggestions" && method === "GET")
      return json({ suggestions, reviews: [] });
    if (url === "/v1/ae/roles" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as AeRolesState;
      return put ? put(body) : json({ ...body, revision: body.revision + 1, starters: [] });
    }
    if (method === "POST") return post[url] ?? json({ ok: true });
    return json({}, 404);
  });
  return calls;
}

function mount(state: AeRolesState) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AePresetInsightsBlock state={state} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.showToast.mockReset();
  mocks.admin.value = false;
});
afterEach(cleanup);

describe("the words", () => {
  it("writes a day and picks the user's own live suggestions", () => {
    expect(aeInsightsDay("2026-10-20T12:00:00Z")).toMatch(/Oct\s20/);
    expect(aeInsightsDay(null)).toBe("");
    expect(aeInsightsDay("not a date")).toBe("");
    const rows = aeOwnSuggestions([
      suggestion(),
      suggestion({ id: "b", status: "dismissed" }),
      suggestion({ id: "c", kind: "starter" }),
      suggestion({ id: "d", status: "applied", can_apply: false, can_undo: true }),
    ]);
    expect(rows.map((s) => s.id)).toEqual(["sg_1", "d"]);
  });
});

describe("off", () => {
  it("shows the switch and the off copy, and reads nothing", () => {
    const calls = serve();
    mount(stateOf());
    expect(
      screen.getByRole("switch", { name: "Collect run logs and review presets" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/Off\. The Admin Center card still shows runs/)).toBeInTheDocument();
    expect(screen.queryByText("Every 2 weeks")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("turning it on saves insights with weeks 2 and scope all", async () => {
    const calls = serve();
    mount(stateOf());
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith("Preset insights are on."));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(put?.body ?? "{}").insights).toEqual({
      enabled: true,
      weeks: 2,
      scope: "all",
    });
  });

  it("shows the scheduled task's error from the save", async () => {
    serve({
      put: (body) =>
        json({
          ...body,
          revision: 4,
          starters: [],
          insights_task: { ok: false, action: "none", error: "agent preset-reviewer is missing" },
        }),
    });
    mount(stateOf());
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toHaveTextContent("agent preset-reviewer is missing");
  });

  it("a conflict toasts and keeps the switch as it was", async () => {
    serve({ put: (body) => json({ error: { ...body, revision: 9, starters: [] } }, 409) });
    mount(stateOf());
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith(
        "Your roles changed on another device, so the saved presets were reloaded.",
      ),
    );
  });
});

describe("Presets card shows", () => {
  it("renders in the off state, defaults to Both, and saves only show", async () => {
    const calls = serve();
    mount(stateOf({ insights: { enabled: false, weeks: 2, scope: "all" } }));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("group", { name: "Presets card shows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Both" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(put?.body ?? "{}").insights).toEqual({
      enabled: false,
      weeks: 2,
      scope: "all",
      show: "tokens",
    });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("renders in the on state, shows the saved pick, and keeps scope and weeks", async () => {
    mocks.admin.value = true;
    const calls = serve();
    mount(stateOf({ insights: { enabled: true, weeks: 4, scope: "own", show: "tokens" } }));
    expect(screen.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(put?.body ?? "{}").insights).toEqual({
      enabled: true,
      weeks: 4,
      scope: "own",
      show: "cost",
    });
  });

  it("the other controls keep the saved show", async () => {
    mocks.admin.value = true;
    const calls = serve();
    mount(stateOf({ insights: { enabled: true, weeks: 2, scope: "all", show: "cost" } }));
    fireEvent.click(screen.getByRole("button", { name: "Own" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(put?.body ?? "{}").insights.show).toBe("cost");
  });
});

describe("review frequency", () => {
  it("shows Every 2 weeks as pressed when nothing is saved", () => {
    serve();
    mount(stateOf({ insights: ON }));
    expect(screen.getByRole("button", { name: "Every 2 weeks" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Monthly" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // The Run now sentence shows only while Monthly is selected.
    expect(screen.queryByText(/up to 8 weeks/)).toBeNull();
  });

  it("shows the Run now sentence, worded up to 8 weeks, only on Monthly", () => {
    serve();
    mount(stateOf({ insights: { ...ON, frequency: "monthly" } }));
    expect(screen.getByText(/can push the next Monthly review out by up to 8 weeks/)).toBeTruthy();
  });

  it("an unknown frequency from the server reads as Every 2 weeks", () => {
    serve();
    mount(stateOf({ insights: { ...ON, frequency: "daily" as never } }));
    expect(screen.getByRole("button", { name: "Every 2 weeks" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("ties the hint to the group with aria-describedby", () => {
    serve();
    mount(stateOf({ insights: ON }));
    const group = screen.getByRole("group", { name: "Frequency" });
    const hint = document.getElementById(group.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toMatch(/07:00 \(server time\)/);
  });

  it("keeps the buttons focusable and ignores clicks while a save is running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = serve();
    const original = mocks.fetch.getMockImplementation();
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") await gate;
      return original?.(url, init);
    });
    mount(stateOf({ insights: ON }));
    const monthly = screen.getByRole("button", { name: "Monthly" });
    monthly.focus();
    fireEvent.click(monthly);
    await waitFor(() => expect(monthly).toHaveAttribute("aria-disabled", "true"));
    expect(monthly).not.toBeDisabled();
    expect(document.activeElement).toBe(monthly);
    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    release();
    await waitFor(() => expect(monthly).not.toHaveAttribute("aria-disabled"));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("shows the saved value", () => {
    serve();
    mount(stateOf({ insights: { ...ON, frequency: "weekly" } }));
    expect(screen.getByRole("button", { name: "Weekly" })).toHaveAttribute("aria-pressed", "true");
  });

  it("a change sends insights.frequency and keeps the other settings", async () => {
    const calls = serve();
    mount(stateOf({ insights: { ...ON, show: "cost" } }));
    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(put?.body ?? "{}").insights).toEqual({
      ...ON,
      show: "cost",
      frequency: "monthly",
    });
  });

  it("clicking the pressed value saves nothing", () => {
    const calls = serve();
    mount(stateOf({ insights: ON }));
    fireEvent.click(screen.getByRole("button", { name: "Every 2 weeks" }));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("on", () => {
  it("lists how often, the reviewer, the scope, the dates and the open count", async () => {
    serve();
    mount(stateOf({ insights: ON }));
    expect(screen.getByText("Every 2 weeks")).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Default planner \(Balanced: Opus 5\.5 high\), capped at \$2 per run/,
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Last review Oct\s\d+, next Nov\s\d+/)).toBeInTheDocument();
    expect(screen.getByText("1 suggestion waiting")).toBeInTheDocument();
    expect(screen.getByText("Starters and your own presets.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Own" })).toBeNull();
  });

  it("an admin picks the scope and it saves", async () => {
    mocks.admin.value = true;
    const calls = serve();
    mount(stateOf({ insights: ON }));
    fireEvent.click(screen.getByRole("button", { name: "Own" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(put?.body ?? "{}").insights.scope).toBe("own");
  });

  it("Run now posts to the run route and says so", async () => {
    const calls = serve();
    mount(stateOf({ insights: ON }));
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url === "/v1/ae/preset-review/run")).toBe(
        true,
      ),
    );
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
  });

  it("Run now shows the server's message on a 409", async () => {
    serve({
      post: {
        "/v1/ae/preset-review/run": json(
          { error: { code: "review_running", message: "A review is already running." } },
          409,
        ),
      },
    });
    mount(stateOf({ insights: ON }));
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith("A review is already running."),
    );
  });
});

describe("suggestions", () => {
  it("Apply and Dismiss show on an open one, and Apply posts", async () => {
    const calls = serve();
    mount(stateOf({ insights: ON }));
    const row = await screen.findByTestId("ae-preset-suggestion-sg_1");
    expect(row).toHaveTextContent("Deep debug: Builder Opus high to Sonnet high");
    expect(row).toHaveTextContent("Expected saving: about $5 per run");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/v1/ae/preset-suggestions/sg_1/apply")).toBe(true),
    );
  });

  it("shows what Apply will change above the buttons", async () => {
    serve({
      suggestions: [
        suggestion({ changes_text: "Builder: claude-opus-5-5 high to claude-sonnet-5-5 medium" }),
      ],
    });
    mount(stateOf({ insights: ON }));
    const changes = await screen.findByTestId("ae-preset-changes-sg_1");
    expect(changes).toHaveTextContent("Builder: claude-opus-5-5 high to claude-sonnet-5-5 medium");
  });

  it("an undone one offers Apply and Dismiss", async () => {
    serve({ suggestions: [suggestion({ status: "undone" })] });
    mount(stateOf({ insights: ON }));
    await screen.findByTestId("ae-preset-suggestion-sg_1");
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("after Run now it polls every 15 s until a newer review shows up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let fresh = false;
      const calls = serve({
        status: () => (fresh ? { ...STATUS, last_review: "2999-01-01T00:00:00Z" } : STATUS),
      });
      mount(stateOf({ insights: ON }));
      await screen.findByTestId("ae-preset-suggestion-sg_1");
      fireEvent.click(screen.getByRole("button", { name: "Run now" }));
      await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
      const reads = () =>
        calls.filter((c) => c.method === "GET" && c.url === "/v1/ae/preset-review").length;
      const before = reads();
      await vi.advanceTimersByTimeAsync(15_500);
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
      fresh = true;
      await vi.advanceTimersByTimeAsync(15_500);
      await waitFor(() => expect(reads()).toBeGreaterThan(before + 1));
      const settled = reads();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads()).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an applied one offers Undo only", async () => {
    serve({ suggestions: [suggestion({ status: "applied", can_apply: false, can_undo: true })] });
    mount(stateOf({ insights: ON }));
    const row = await screen.findByTestId("ae-preset-suggestion-sg_1");
    expect(row).toHaveTextContent("(applied)");
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("the 409 message shows on the row and the buttons stay", async () => {
    const message =
      "This preset changed since the review on Oct 20. Dismiss it or edit the preset yourself.";
    serve({
      post: {
        "/v1/ae/preset-suggestions/sg_1/apply": json(
          { error: { code: "preset_changed", message } },
          409,
        ),
      },
    });
    mount(stateOf({ insights: ON }));
    await screen.findByTestId("ae-preset-suggestion-sg_1");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });
});

describe("the roles cache after Apply", () => {
  function mountWithClient(state: AeRolesState) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <AePresetInsightsBlock state={state} />
      </QueryClientProvider>,
    );
    const rolesRead = () =>
      invalidate.mock.calls.some(
        ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(["ae", "roles"]),
      );
    return { rolesRead };
  }

  it("a refused Apply reads the roles again", async () => {
    serve({
      post: {
        "/v1/ae/preset-suggestions/sg_1/apply": json(
          { error: { code: "preset_changed", message: "The preset changed." } },
          409,
        ),
      },
    });
    const { rolesRead } = mountWithClient(stateOf({ insights: ON }));
    await screen.findByTestId("ae-preset-suggestion-sg_1");
    expect(rolesRead()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByRole("alert");
    expect(rolesRead()).toBe(true);
  });

  it("a successful Apply whose answer has no roles reads them again", async () => {
    serve({ post: { "/v1/ae/preset-suggestions/sg_1/apply": json({ ok: true }) } });
    const { rolesRead } = mountWithClient(stateOf({ insights: ON }));
    await screen.findByTestId("ae-preset-suggestion-sg_1");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(rolesRead()).toBe(true));
  });

  it("a successful Apply that carries the roles does not", async () => {
    serve({
      post: {
        "/v1/ae/preset-suggestions/sg_1/apply": json({
          ok: true,
          roles: stateOf({ insights: ON }),
        }),
      },
    });
    const { rolesRead } = mountWithClient(stateOf({ insights: ON }));
    await screen.findByTestId("ae-preset-suggestion-sg_1");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled());
    expect(rolesRead()).toBe(false);
  });
});
