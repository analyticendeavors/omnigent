import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));

import { AE_SETTING_HINTS } from "@/lib/aeSettingHints";
import { authenticatedFetch } from "@/lib/identity";
import { AeChildPromptSettings } from "./AeChildPromptSettings";

const STATE = {
  revision: 3,
  default_preset: "balanced",
  apply_start_on: true,
  presets: [
    {
      id: "balanced",
      title: "Balanced",
      icon: "scale",
      color: "teal",
      description: "",
      roles: {
        lead: { mode: "session" },
        planner: { mode: "auto" },
        reviewer: { mode: "auto" },
        builder: { mode: "auto" },
        helper: { mode: "auto" },
      },
      rules: { raise_or_lower: "tell", lead_steps_down: true, auto_raises: 1 },
    },
  ],
  starters: [],
};

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AeChildPromptSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.mocked(authenticatedFetch).mockReset());
afterEach(cleanup);

describe("AeChildPromptSettings", () => {
  it("gives each control a non-empty hint, shown on its row and as the phone tooltip", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => json(STATE));
    mount();
    const rows = [
      ["ae-child-prompts", "family.child_prompts"],
      ["ae-child-relay", "family.relay"],
      ["ae-handoff", "family.handoff"],
    ] as const;
    await screen.findByTestId("ae-child-prompts");
    for (const [testId, id] of rows) {
      const row = screen.getByTestId(testId);
      const { label, hint } = AE_SETTING_HINTS[id];
      expect(hint.trim()).not.toBe("");
      expect(row.textContent).toContain(hint);
      // Reachable by keyboard focus and tap: the phone tooltip is a real button.
      const about = screen.getByRole("button", { name: `About ${label}` });
      expect(about.tabIndex).toBeGreaterThanOrEqual(0);
    }
    expect(AE_SETTING_HINTS["family.child_prompts"].hint).toBe(
      "Questions and permission prompts from sessions this chat started show in its action dock, with their buttons. Default: on.",
    );
    expect(AE_SETTING_HINTS["family.relay"].hint).toBe(
      "The lead may pass your answer to a child's question. It can never approve tool use or MCP writes for a child. Default: on.",
    );
  });

  it("reads unset as on and off when the server says false", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => json({ ...STATE, child_relay: false }));
    mount();
    const prompts = await screen.findByTestId("ae-child-prompts-toggle");
    const relay = screen.getByTestId("ae-child-relay-toggle");
    await waitFor(() => expect(prompts).not.toBeDisabled());
    expect(prompts).toBeChecked();
    expect(relay).not.toBeChecked();
  });

  it("saves the flag with the rest of the roles at its revision", async () => {
    vi.mocked(authenticatedFetch).mockImplementation((_path, init) =>
      json(init?.method === "PUT" ? { ...STATE, revision: 4, child_prompts: false } : STATE),
    );
    mount();
    const toggle = await screen.findByTestId("ae-child-prompts-toggle");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    await waitFor(() => {
      const put = vi
        .mocked(authenticatedFetch)
        .mock.calls.find(([, init]) => init?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put![1]!.body))).toMatchObject({
        revision: 3,
        default_preset: "balanced",
        child_prompts: false,
      });
    });
    await waitFor(() => expect(screen.getByTestId("ae-child-prompts-toggle")).not.toBeChecked());
  });

  it("reads the suggest-compacting size as 300 and on when unset, and as off at 0", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => json(STATE));
    mount();
    const input = await screen.findByTestId("ae-handoff-tokens");
    await waitFor(() => expect(screen.getByTestId("ae-handoff-toggle")).not.toBeDisabled());
    expect(input).toHaveValue(300);
    expect(input).toHaveAttribute("aria-label", "Suggest compacting at, in thousands of tokens");
    expect(screen.getByTestId("ae-handoff").textContent).toContain("Suggest compacting at");
    expect(screen.getByTestId("ae-handoff-toggle")).toBeChecked();
    cleanup();
    vi.mocked(authenticatedFetch).mockImplementation(() =>
      json({ ...STATE, lead_handoff_tokens: 0 }),
    );
    mount();
    const toggle = await screen.findByTestId("ae-handoff-toggle");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toBeChecked();
    expect(screen.queryByTestId("ae-handoff-tokens")).toBeNull();
  });

  const puts = () =>
    vi
      .mocked(authenticatedFetch)
      .mock.calls.filter(([, init]) => init?.method === "PUT")
      .map(([, init]) => JSON.parse(String(init!.body)));

  it("saves a new size in tokens when the box loses focus", async () => {
    vi.mocked(authenticatedFetch).mockImplementation((_path, init) =>
      json(init?.method === "PUT" ? { ...STATE, revision: 4, lead_handoff_tokens: 200000 } : STATE),
    );
    mount();
    const input = await screen.findByTestId("ae-handoff-tokens");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toMatchObject({ revision: 3, lead_handoff_tokens: 200000 });
  });

  it("ignores a size outside 50 to 5000 and puts the saved one back", async () => {
    vi.mocked(authenticatedFetch).mockImplementation(() => json(STATE));
    mount();
    const input = await screen.findByTestId("ae-handoff-tokens");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveValue(300));
    expect(puts()).toHaveLength(0);
  });

  it("the switch saves 0 to turn it off and clears the value to turn it back on", async () => {
    let saved: number | null | undefined;
    vi.mocked(authenticatedFetch).mockImplementation((_path, init) => {
      if (init?.method === "PUT") {
        saved = JSON.parse(String(init.body)).lead_handoff_tokens;
        return json({
          ...STATE,
          revision: 4,
          ...(typeof saved === "number" ? { lead_handoff_tokens: saved } : {}),
        });
      }
      return json(STATE);
    });
    mount();
    const toggle = await screen.findByTestId("ae-handoff-toggle");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(saved).toBe(0));
    await waitFor(() => expect(screen.getByTestId("ae-handoff-toggle")).not.toBeChecked());
    fireEvent.click(screen.getByTestId("ae-handoff-toggle"));
    await waitFor(() => expect(saved).toBeNull());
    await waitFor(() => expect(screen.getByTestId("ae-handoff-toggle")).toBeChecked());
  });
});
