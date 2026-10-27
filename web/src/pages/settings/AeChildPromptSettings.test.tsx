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
});
