// Settings > Roles: the starters from GET, saving an edited role table, the
// conflict path (409 carries the current state), a new preset, restoring
// starters, reordering and pinning, the top-tier warning and delete.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AeRolePreset, AeRolesState } from "@/lib/aeRoles";
import { AE_SETTING_HINTS, type AeSettingHintId } from "@/lib/aeSettingHints";
import type * as AeTablerIconModule from "@/lib/aeTablerIcon";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), showToast: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));
vi.mock("@/components/ui/toast", () => ({ showToast: mocks.showToast }));
vi.mock("@/hooks/useIsAdmin", () => ({ useIsAdmin: () => false }));
vi.mock("@/hooks/useAeReviewerAgents", () => ({
  useAeReviewerAgents: () => ({ options: [], host: null, loaded: false }),
}));
vi.mock("@/hooks/useHosts", () => ({
  useHosts: () => ({
    data: [
      {
        host_id: "h1",
        name: "box",
        owner: "me",
        status: "online",
        configured_harnesses: { "claude-native": true },
      },
    ],
  }),
  useHostModelOptions: () => ({
    data: [
      { id: "sonnet", model: "claude-sonnet-5-5", displayName: "Sonnet", isDefault: true },
      { id: "claude-fable-5-1[1m]", model: "claude-fable-5-1", displayName: "Fable" },
      { id: "opus", model: "claude-opus-5-5", displayName: "Opus" },
      { id: "haiku", model: "claude-haiku-5-5", displayName: "Haiku" },
    ],
    isError: false,
    isFetching: false,
  }),
}));
vi.mock("@/components/AeTablerIconPicker", () => ({
  AeTablerIconPicker: ({ onSelect }: { onSelect: (value: string) => void }) => (
    <button type="button" onClick={() => onSelect("tabler:flame")}>
      pick flame
    </button>
  ),
}));
vi.mock("@/lib/aeTablerIcon", async (importOriginal) => ({
  ...(await importOriginal<typeof AeTablerIconModule>()),
  AeProjectIconGlyph: () => null,
}));

import { AeRolesSettingsSection } from "./AeRolesSettingsSection";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const FABLE = "claude-fable-5-1";

const fixed = (model: string, effort: "low" | "medium" | "high" | "xhigh" | "max") =>
  ({ mode: "fixed", model, effort }) as const;

const SAVE_TOKENS: AeRolePreset = {
  id: "save-tokens",
  title: "Save tokens",
  icon: "coins",
  color: "green",
  description: "Sonnet plans, Haiku does the rest",
  when_to_use: "Routine work.",
  pinned: false,
  roles: {
    lead: { mode: "session" },
    planner: fixed(SONNET, "high"),
    reviewer: fixed(HAIKU, "medium"),
    builder: fixed(HAIKU, "medium"),
    helper: fixed(HAIKU, "low"),
  },
  rules: { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1 },
};
const BALANCED: AeRolePreset = {
  id: "balanced",
  title: "Balanced",
  icon: "scale",
  color: "teal",
  description: "Opus plans, Sonnet builds and reviews",
  when_to_use: "Most work.",
  pinned: false,
  roles: {
    lead: { mode: "session" },
    planner: fixed(OPUS, "high"),
    reviewer: fixed(SONNET, "medium"),
    builder: fixed(SONNET, "medium"),
    helper: fixed(HAIKU, "low"),
  },
  rules: { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1 },
};
const YOLO: AeRolePreset = {
  id: "yolo",
  title: "YOLO",
  icon: "rocket",
  color: "red",
  description: "Fable at max on every role, no automatic model changes",
  when_to_use: "Hard problems.",
  pinned: false,
  roles: {
    lead: fixed(FABLE, "max"),
    planner: fixed(FABLE, "max"),
    reviewer: fixed(FABLE, "max"),
    builder: fixed(FABLE, "max"),
    helper: fixed(FABLE, "max"),
  },
  rules: { raise_or_lower: "off", lead_steps_down: false, auto_raises: 0 },
};
const STARTERS = [SAVE_TOKENS, BALANCED, YOLO];

function stateOf(patch: Partial<AeRolesState> = {}): AeRolesState {
  return {
    revision: 0,
    default_preset: "balanced",
    apply_start_on: true,
    presets: STARTERS,
    starters: STARTERS,
    ...patch,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** GET answers `initial`; each PUT is saved as the next revision unless `putAnswer` says otherwise. */
function serve(initial: AeRolesState, putAnswer?: (body: AeRolesState) => Response) {
  mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as AeRolesState;
      if (putAnswer) return putAnswer(body);
      return json({ ...body, revision: body.revision + 1, starters: STARTERS });
    }
    return json(initial);
  });
}

function puts(): AeRolesState[] {
  return mocks.fetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AeRolesSettingsSection />
    </QueryClientProvider>,
  );
  return qc;
}

function editor() {
  return within(screen.getByTestId("ae-roles-editor"));
}

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.showToast.mockReset();
});

afterEach(cleanup);

describe("AeRolesSettingsSection", () => {
  it("renders a hint for every Roles control in the inventory", async () => {
    const two = {
      mode: "multi" as const,
      reviewers: [fixed(SONNET, "medium"), fixed(HAIKU, "low")],
    };
    const balanced = { ...BALANCED, roles: { ...BALANCED.roles, reviewer: two } };
    serve(
      stateOf({
        presets: [balanced, SAVE_TOKENS, YOLO],
        insights: { enabled: true, weeks: 2, scope: "all" },
      }),
    );
    renderSection();
    await screen.findByRole("heading", { name: "Balanced" });
    fireEvent.click(screen.getByRole("button", { name: "New preset" }));
    const form = await screen.findByTestId("ae-preset-form");
    const page = document.body.textContent ?? "";
    const prefixes = ["roles.", "rules.", "reviewer.", "preset.", "insights."];
    // "reviewer.older" sits inside the model picker's list, which exists only while it is open (AeReviewerRows.test.tsx).
    const ids = (Object.keys(AE_SETTING_HINTS) as AeSettingHintId[]).filter(
      (id) => id !== "reviewer.older" && prefixes.some((prefix) => id.startsWith(prefix)),
    );
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      const { hint, source } = AE_SETTING_HINTS[id];
      expect(hint.trim(), id).not.toBe("");
      if (source === "tooltip") {
        // The form is a dialog, so its icons are in the form, the rest behind it.
        const icons = screen.queryAllByTestId(`ae-hint-${id}`);
        expect(icons.length, id).toBeGreaterThan(0);
      } else {
        expect(page, id).toContain(hint);
      }
    }
    expect(within(form).getByTestId("ae-hint-preset.default")).toBeInTheDocument();
  });

  it("renders the starters from GET with the default open", async () => {
    serve(stateOf());
    renderSection();
    expect(await screen.findByRole("heading", { name: "Balanced" })).toBeInTheDocument();
    const row = within(screen.getByTestId("ae-roles-row"));
    expect(row.getByRole("button", { name: "Balanced, your default, open" })).toBeInTheDocument();
    expect(row.getAllByRole("button", { name: "2 more presets" })[0]).toBeInTheDocument();
    expect(editor().getByLabelText("Planner model")).toHaveValue(OPUS);
    expect(editor().getByLabelText("Lead model")).toHaveValue("__session");
    expect(screen.queryByTestId("ae-roles-top-tier")).not.toBeInTheDocument();
    // The catalog's 1M Fable row and the plain one are one choice.
    const options = within(editor().getByLabelText("Builder model")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Auto (the lead picks)",
      "Sonnet 5.5",
      "Fable 5.1",
      "Opus 5.5",
      "Haiku 5.5",
    ]);
  });

  it("saves an edited role table as the whole list and clears the draft", async () => {
    serve(stateOf({ revision: 4 }));
    renderSection();
    await screen.findByRole("heading", { name: "Balanced" });
    const save = editor().getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    const builderEffort = editor().getByRole("radiogroup", { name: "Builder effort" });
    fireEvent.click(within(builderEffort).getByRole("radio", { name: "High" }));
    fireEvent.change(editor().getByLabelText("Helper model"), { target: { value: "__auto" } });
    fireEvent.click(
      within(editor().getByTestId("ae-rule-raise")).getByRole("radio", { name: "Ask first" }),
    );
    fireEvent.click(editor().getByRole("button", { name: "More: Automatic raises per child" }));
    fireEvent.click(save);
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = puts()[0];
    expect(body).toEqual({
      revision: 4,
      default_preset: "balanced",
      apply_start_on: true,
      presets: [
        SAVE_TOKENS,
        {
          ...BALANCED,
          roles: { ...BALANCED.roles, builder: fixed(SONNET, "high"), helper: { mode: "auto" } },
          rules: { raise_or_lower: "ask", lead_steps_down: true, auto_raises: 2 },
        },
        YOLO,
      ],
    });
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith("Saved Balanced."));
    expect(editor().getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      within(editor().getByRole("radiogroup", { name: "Builder effort" })).getByRole("radio", {
        name: "High",
      }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("saves the Helpers rule with the preset and tags in-house presets in the list", async () => {
    const solo: AeRolePreset = {
      ...BALANCED,
      id: "solo",
      title: "Solo",
      rules: { ...BALANCED.rules, helpers: "own" },
    };
    serve(stateOf({ revision: 2, presets: [...STARTERS, solo] }));
    renderSection();
    await screen.findByRole("heading", { name: "Balanced" });
    const helpers = editor().getByTestId("ae-rule-helpers");
    expect(within(helpers).getByRole("radio", { name: "Any agent or session" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(helpers).getByRole("radio", { name: "Own subagents only" }));
    fireEvent.click(editor().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].presets[1].rules).toEqual({ ...BALANCED.rules, helpers: "own" });
    expect(puts()[0].presets[3]).toEqual(solo);
    fireEvent.click(screen.getByRole("button", { name: "All presets" }));
    expect(
      await screen.findAllByTitle("Own subagents only: no other agents or sessions"),
    ).toHaveLength(2);
  });

  it("reloads the server's state on a conflict, says so and keeps the edits", async () => {
    const current = stateOf({
      revision: 7,
      presets: [SAVE_TOKENS, { ...BALANCED, description: "Changed elsewhere" }, YOLO],
    });
    serve(stateOf({ revision: 2 }), () =>
      json({ error: { message: "stale revision", ...current } }, 409),
    );
    const qc = renderSection();
    await screen.findByRole("heading", { name: "Balanced" });
    fireEvent.click(
      within(editor().getByRole("radiogroup", { name: "Planner effort" })).getByRole("radio", {
        name: "Max",
      }),
    );
    fireEvent.click(editor().getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith(
        expect.stringContaining("changed on another device"),
      ),
    );
    expect(qc.getQueryData(["ae", "roles"])).toMatchObject({ revision: 7 });
    expect(await screen.findByText(/Changed elsewhere/)).toBeInTheDocument();
    expect(editor().getByRole("button", { name: "Save" })).toBeEnabled();
    serve(current);
    fireEvent.click(editor().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts().at(-1)?.revision).toBe(7));
  });

  it("says why a save was refused and keeps the edits", async () => {
    serve(stateOf(), () =>
      json({ detail: [{ loc: ["body", "presets"], msg: "title has a control character" }] }, 422),
    );
    renderSection();
    await screen.findByRole("heading", { name: "Balanced" });
    fireEvent.click(
      within(editor().getByRole("radiogroup", { name: "Planner effort" })).getByRole("radio", {
        name: "Max",
      }),
    );
    fireEvent.click(editor().getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith(
        "Could not save your presets: PUT /v1/ae/roles answered 422: title has a control character. Nothing changed; try again.",
      ),
    );
    expect(editor().getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("creates a new preset as a copy of the open one", async () => {
    serve(stateOf());
    renderSection();
    await screen.findByRole("heading", { name: "Balanced" });
    fireEvent.click(
      within(screen.getByTestId("ae-roles-row")).getByRole("button", { name: "New preset" }),
    );
    const form = within(await screen.findByTestId("ae-preset-form"));
    expect(form.getByText(/Starting from: Balanced/)).toBeInTheDocument();
    expect(form.getByText("Alt 4")).toBeInTheDocument();
    fireEvent.change(form.getByLabelText("Icon and name"), { target: { value: "Hot fix" } });
    fireEvent.change(form.getByLabelText("Description, shown on the card"), {
      target: { value: "Opus fixes, Sonnet checks" },
    });
    fireEvent.change(form.getByLabelText(/^When to use/), {
      target: { value: "A known bug.\nShips today." },
    });
    fireEvent.click(form.getByRole("button", { name: "Icon and color" }));
    fireEvent.click(await screen.findByRole("button", { name: "pick flame" }));
    fireEvent.click(screen.getByRole("radio", { name: "amber" }));
    fireEvent.click(form.getByRole("checkbox", { name: "Make my default" }));
    fireEvent.click(form.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = puts()[0];
    expect(body.default_preset).toBe("hot-fix");
    expect(body.presets.map((p) => p.id)).toEqual(["save-tokens", "balanced", "yolo", "hot-fix"]);
    expect(body.presets[3]).toEqual({
      id: "hot-fix",
      title: "Hot fix",
      icon: "flame",
      color: "amber",
      description: "Opus fixes, Sonnet checks",
      when_to_use: "A known bug. Ships today.",
      pinned: false,
      roles: BALANCED.roles,
      rules: BALANCED.rules,
    });
    expect(await screen.findByRole("heading", { name: "Hot fix" })).toBeInTheDocument();
    expect(screen.queryByTestId("ae-preset-form")).not.toBeInTheDocument();
  });

  it("restores missing starters at the end of the list", async () => {
    serve(stateOf({ presets: [BALANCED] }));
    renderSection();
    await screen.findByRole("heading", { name: "Balanced" });
    fireEvent.click(screen.getByRole("button", { name: "Restore starters" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].presets.map((p) => p.id)).toEqual(["balanced", "save-tokens", "yolo"]);
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith("Restored Save tokens, YOLO."),
    );
  });

  it("says the preset limit blocks restoring starters at 30 presets", async () => {
    const full = Array.from({ length: 30 }, (_, n) => ({
      ...BALANCED,
      id: `p${n}`,
      title: `Preset ${n}`,
    }));
    serve(stateOf({ presets: full, default_preset: "p0" }));
    renderSection();
    await screen.findByRole("heading", { name: "Preset 0" });
    fireEvent.click(screen.getByRole("button", { name: "Restore starters" }));
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining("30 presets")),
    );
    expect(mocks.showToast).not.toHaveBeenCalledWith("Every starter is already in your list.");
    expect(puts()).toHaveLength(0);
  });

  it("disables the editing controls while a save is in flight and keeps a later edit", async () => {
    let release: (r: Response) => void = () => {};
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as AeRolesState;
        return new Promise<Response>((resolve) => {
          release = () =>
            resolve(json({ ...body, revision: body.revision + 1, starters: STARTERS }));
        });
      }
      return json(stateOf());
    });
    renderSection();
    await screen.findByRole("heading", { name: "Balanced" });
    fireEvent.click(
      within(editor().getByRole("radiogroup", { name: "Builder effort" })).getByRole("radio", {
        name: "High",
      }),
    );
    fireEvent.click(editor().getByRole("button", { name: "Save" }));
    await waitFor(() => expect(editor().getByRole("button", { name: "Saving…" })).toBeDisabled());
    expect(editor().getByLabelText("Helper model")).toBeDisabled();
    expect(
      within(editor().getByRole("radiogroup", { name: "Builder effort" })).getByRole("radio", {
        name: "Low",
      }),
    ).toBeDisabled();
    expect(
      editor().getByRole("button", { name: "More: Automatic raises per child" }),
    ).toBeDisabled();
    expect(
      within(editor().getByTestId("ae-rule-raise")).getByRole("radio", { name: "Ask first" }),
    ).toBeDisabled();
    expect(editor().getByRole("button", { name: "Duplicate Balanced" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New preset" })).toBeDisabled();
    release(json({}));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith("Saved Balanced."));
    expect(editor().getByLabelText("Helper model")).not.toBeDisabled();
  });

  it("reorders with a grip's arrow keys and pins to the top group", async () => {
    serve(stateOf());
    renderSection();
    await screen.findByRole("heading", { name: "Balanced" });
    fireEvent.click(screen.getByRole("button", { name: "All presets" }));
    const list = within(screen.getByTestId("ae-roles-list"));
    const grip = list.getByRole("button", { name: /^Move YOLO/ });
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].presets.map((p) => p.id)).toEqual(["save-tokens", "yolo", "balanced"]);
    await waitFor(() =>
      expect(document.activeElement).toBe(list.getByRole("button", { name: /^Move YOLO/ })),
    );
    await waitFor(() => expect(list.getByRole("button", { name: "Pin Balanced" })).toBeEnabled());
    fireEvent.click(list.getByRole("button", { name: "Pin Balanced" }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1].presets.map((p) => [p.id, p.pinned])).toEqual([
      ["balanced", true],
      ["save-tokens", false],
      ["yolo", false],
    ]);
  });

  it("warns when every role is the top model at max effort", async () => {
    serve(stateOf());
    renderSection();
    await screen.findByRole("heading", { name: "Balanced" });
    fireEvent.click(screen.getByRole("button", { name: "All presets" }));
    fireEvent.click(within(screen.getByTestId("ae-roles-list")).getByText("YOLO"));
    expect(await screen.findByTestId("ae-roles-top-tier")).toHaveTextContent(
      "Top cost tier on every role.",
    );
    fireEvent.click(
      within(editor().getByRole("radiogroup", { name: "Helper effort" })).getByRole("radio", {
        name: "Low",
      }),
    );
    expect(screen.queryByTestId("ae-roles-top-tier")).not.toBeInTheDocument();
  });

  it("deletes the default after confirming and names the fallback", async () => {
    serve(stateOf());
    renderSection();
    await screen.findByRole("heading", { name: "Balanced" });
    fireEvent.click(editor().getByRole("button", { name: "Delete Balanced" }));
    const dialog = within(await screen.findByTestId("ae-preset-delete"));
    expect(
      dialog.getByText(/Sessions using it fall back to your default \(Save tokens\)/),
    ).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toMatchObject({ default_preset: "save-tokens" });
    expect(puts()[0].presets.map((p) => p.id)).toEqual(["save-tokens", "yolo"]);
    expect(await screen.findByRole("heading", { name: "Save tokens" })).toBeInTheDocument();
  });

  describe("collapsed row width", () => {
    const original = globalThis.ResizeObserver;
    const withWidth = (width: number) => {
      globalThis.ResizeObserver = class {
        cb: ResizeObserverCallback;
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb;
        }
        observe() {
          this.cb(
            [{ contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    };
    afterEach(() => {
      globalThis.ResizeObserver = original;
    });

    it("shows every preset as an icon when the bar has room", async () => {
      withWidth(900);
      serve(stateOf());
      renderSection();
      const row = within(await screen.findByTestId("ae-roles-row"));
      expect(row.getByRole("button", { name: "Save tokens" })).toBeInTheDocument();
      expect(row.getByRole("button", { name: "YOLO" })).toBeInTheDocument();
      expect(row.queryByRole("button", { name: /more presets/ })).not.toBeInTheDocument();
    });

    it("puts only the presets that do not fit behind +N", async () => {
      withWidth(300);
      const many = Array.from({ length: 9 }, (_, i) => ({
        ...SAVE_TOKENS,
        id: `p${i}`,
        title: `Preset ${i}`,
      }));
      serve(stateOf({ presets: [...STARTERS, ...many] }));
      renderSection();
      const row = within(await screen.findByTestId("ae-roles-row"));
      // 300 px less the open chip (0 in jsdom plus its gap) and the new button
      // leaves room for 6 icons and "+N": 11 others, 6 shown, 5 hidden.
      expect(row.getByRole("button", { name: "5 more presets" })).toHaveTextContent("+5");
      expect(row.getByRole("button", { name: "Save tokens" })).toBeInTheDocument();
    });
  });

  describe("collapsed row after switching presets", () => {
    const original = globalThis.ResizeObserver;
    const widthOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    afterEach(() => {
      globalThis.ResizeObserver = original;
      if (widthOf) Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthOf);
    });

    it("recounts the hidden presets when the open preset has a long title", async () => {
      globalThis.ResizeObserver = class {
        cb: ResizeObserverCallback;
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb;
        }
        observe() {
          this.cb(
            [{ contentRect: { width: 400 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
      // The open chip is as wide as its text; every other element measures 0.
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
        configurable: true,
        get(this: HTMLElement) {
          return this.getAttribute("aria-current") === "true"
            ? (this.textContent ?? "").length * 8
            : 0;
        },
      });
      const many = Array.from({ length: 9 }, (_, i) => ({
        ...SAVE_TOKENS,
        id: `p${i}`,
        title: `P${i}`,
      }));
      const long = { ...SAVE_TOKENS, id: "long", title: "A preset with a rather long title" };
      serve(stateOf({ presets: [long, ...STARTERS, ...many] }));
      renderSection();
      const row = within(await screen.findByTestId("ae-roles-row"));
      const hiddenNow = () =>
        Number(
          /\+(\d+)/.exec(row.getByRole("button", { name: /more presets/ }).textContent ?? "")?.[1],
        );
      const before = hiddenNow();
      fireEvent.click(row.getByRole("button", { name: "A preset with a rather long title" }));
      await waitFor(() => expect(hiddenNow()).toBeGreaterThan(before));
    });
  });

  it("saves the Apply START ON lines switch through the same PUT", async () => {
    serve(stateOf());
    renderSection();
    fireEvent.click(await screen.findByRole("switch", { name: "Apply START ON lines" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].apply_start_on).toBe(false);
  });
});
