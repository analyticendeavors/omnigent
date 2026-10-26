import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AeModelChangeBand } from "./AeModelChangeBand";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));

const KEY = "omnigent:ae-model-changes-dismissed";
const NOW = Math.floor(Date.now() / 1000);

interface Opts {
  id?: string;
  title?: string;
  role?: string | null;
  lead?: boolean;
  kind?: "raise" | "lower";
  at?: number;
  undone?: boolean;
  reason?: string;
}

function item(o: Opts = {}) {
  const kind = o.kind ?? "raise";
  const sonnet = ["claude-sonnet-5-5", "medium"];
  const opus = ["claude-opus-4-8", "high"];
  return {
    session_id: o.id ?? "conv_b",
    title: o.title ?? "Fix the lock",
    role: o.role === undefined ? "builder" : o.role,
    is_lead: o.lead ?? false,
    change: {
      f: kind === "raise" ? sonnet : opus,
      t: kind === "raise" ? opus : sonnet,
      k: kind === "raise" ? "r" : "l",
      r: o.reason ?? "Stuck on locks",
      a: o.at ?? NOW - 120,
      c: null,
      p: "a",
      ...(kind === "raise" ? {} : { u: opus }),
      ...(o.undone ? { x: 1 } : {}),
    },
  };
}

let feed: unknown[] = [];
let feedStatus = 200;

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function renderBand() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AeModelChangeBand leadId="lead_1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

beforeEach(() => {
  localStorage.clear();
  feed = [];
  feedStatus = 200;
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation((_url: string, init?: { method?: string }) => {
    if (init?.method === "POST") return json({ status: "changed" });
    return json({ changes: feed }, feedStatus);
  });
});
afterEach(cleanup);

const lines = () => screen.queryAllByTestId("ae-model-change-line");

describe("AeModelChangeBand", () => {
  it("renders nothing with no items", async () => {
    renderBand();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("ae-model-change-band")).toBeNull();
  });

  it("renders nothing on a 404 from an older server", async () => {
    feedStatus = 404;
    feed = [item()];
    renderBand();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("ae-model-change-band")).toBeNull();
  });

  it("reads a raise with an amber arrow, the reason, the time and the links", async () => {
    feed = [item()];
    renderBand();
    expect((await screen.findByTestId("ae-model-change-text")).textContent).toBe(
      "Raised Builder “Fix the lock” from Sonnet medium to Opus high",
    );
    expect(screen.getByTestId("ae-model-change-arrow").getAttribute("data-direction")).toBe("up");
    expect(screen.getByTestId("ae-model-change-why").textContent).toContain(
      "Stuck on locks · 2 min ago",
    );
    expect(screen.getByTestId("ae-model-change-undo")).toBeDefined();
    expect(screen.getByText("Open helper").getAttribute("href")).toBe("/c/conv_b");
    const close = screen.getByTestId("ae-model-change-dismiss");
    expect(close.getAttribute("aria-label")).toBe("Dismiss");
    expect(close.getAttribute("title")).toBe("Dismiss");
    expect(close.textContent).toBe("");
    expect(screen.queryByText("Dismiss")).toBeNull();
  });

  it("draws Undo, Open helper and the close box as filled chips", async () => {
    feed = [item()];
    renderBand();
    const undo = await screen.findByTestId("ae-model-change-undo");
    expect(undo.className).toContain("h-[18px]");
    expect(undo.className).toContain("bg-emerald-500/15");
    const helper = screen.getByText("Open helper");
    expect(helper.tagName).toBe("A");
    expect(helper.getAttribute("href")).toBe("/c/conv_b");
    expect(helper.className).toContain("h-[18px]");
    expect(helper.className).toContain("bg-foreground/[0.07]");
    const close = screen.getByTestId("ae-model-change-dismiss");
    expect(close.className).toContain("size-[18px]");
    expect(close.className).toContain("bg-foreground/[0.07]");
  });

  it("disables Undo and reads Undoing while the request is out", async () => {
    feed = [item()];
    mocks.fetch.mockImplementation((_url: string, init?: { method?: string }) =>
      init?.method === "POST" ? new Promise(() => {}) : json({ changes: feed }),
    );
    renderBand();
    fireEvent.click(await screen.findByTestId("ae-model-change-undo"));
    const undo = await screen.findByText("Undoing");
    expect(undo.hasAttribute("disabled")).toBe(true);
  });

  it("shows Undone as plain text, not a chip", async () => {
    feed = [item({ kind: "lower", undone: true })];
    renderBand();
    const undone = await screen.findByTestId("ae-model-change-undone");
    expect(undone.className).not.toContain("bg-");
    expect(screen.queryByTestId("ae-model-change-undo")).toBeNull();
  });

  it("reads a lowering", async () => {
    feed = [item({ kind: "lower" })];
    renderBand();
    expect((await screen.findByTestId("ae-model-change-text")).textContent).toBe(
      "Lowered Builder “Fix the lock” from Opus high to Sonnet medium",
    );
    expect(screen.getByTestId("ae-model-change-arrow").getAttribute("data-direction")).toBe("down");
  });

  it("reads a lead raising itself and stepping down, with no helper link", async () => {
    feed = [
      item({ lead: true, id: "lead_1", role: null }),
      item({ lead: true, id: "lead_2", kind: "lower", at: NOW - 600 }),
    ];
    renderBand();
    const texts = (await screen.findAllByTestId("ae-model-change-text")).map((n) => n.textContent);
    expect(texts).toEqual([
      "Lead raised itself from Sonnet medium to Opus high",
      "Lead stepped down from Opus high to Sonnet medium",
    ]);
    expect(screen.queryByText("Open helper")).toBeNull();
  });

  it("undoes a change, then shows Undone in place of the link", async () => {
    feed = [item()];
    renderBand();
    fireEvent.click(await screen.findByTestId("ae-model-change-undo"));
    feed = [item({ kind: "lower", undone: true, at: NOW })];
    await waitFor(() => expect(screen.getByTestId("ae-model-change-undone")).toBeDefined());
    expect(screen.queryByTestId("ae-model-change-undo")).toBeNull();
    const post = mocks.fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/v1/ae/sessions/conv_b/model");
    expect(JSON.parse(post?.[1].body)).toMatchObject({ undo: true });
  });

  it("shows a short error and keeps the button when Undo fails", async () => {
    feed = [item()];
    mocks.fetch.mockImplementation((_url: string, init?: { method?: string }) =>
      init?.method === "POST"
        ? json({ error: { message: "Preset says no" } }, 409)
        : json({ changes: feed }),
    );
    renderBand();
    fireEvent.click(await screen.findByTestId("ae-model-change-undo"));
    expect(await screen.findByTestId("ae-model-change-error")).toBeDefined();
    expect(screen.getByTestId("ae-model-change-undo").hasAttribute("disabled")).toBe(false);
  });

  it("dismisses a line, remembers it, and shows the session again for a newer change", async () => {
    feed = [item({ at: NOW - 60 })];
    const { qc } = renderBand();
    fireEvent.click(await screen.findByTestId("ae-model-change-dismiss"));
    expect(lines()).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toMatchObject({
      conv_b: { at: NOW - 60 },
    });
    feed = [item({ at: NOW - 60 })];
    await act(() => qc.invalidateQueries({ queryKey: ["ae-model-changes"] }));
    expect(lines()).toHaveLength(0);
    feed = [item({ at: NOW - 5, kind: "lower" })];
    await act(() => qc.invalidateQueries({ queryKey: ["ae-model-changes"] }));
    await waitFor(() => expect(lines()).toHaveLength(1));
  });

  it("shows a second change in the same second as a dismissed one", async () => {
    feed = [item({ at: NOW - 60 })];
    const { qc } = renderBand();
    fireEvent.click(await screen.findByTestId("ae-model-change-dismiss"));
    feed = [item({ at: NOW - 60, kind: "lower" })];
    await act(() => qc.invalidateQueries({ queryKey: ["ae-model-changes"] }));
    await waitFor(() => expect(lines()).toHaveLength(1));
  });

  it("renders nothing on a 403", async () => {
    feedStatus = 403;
    feed = [item()];
    renderBand();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("ae-model-change-band")).toBeNull();
  });

  it("starts hidden for a line dismissed in an earlier visit", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ conv_b: { sig: `${NOW - 60}:claude-opus-4-8:high:0`, at: NOW - 60 } }),
    );
    feed = [item({ at: NOW - 60 })];
    renderBand();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(lines()).toHaveLength(0);
  });

  it("folds past two lines behind a Show link", async () => {
    feed = [
      item({ id: "a", at: NOW - 10 }),
      item({ id: "b", at: NOW - 20 }),
      item({ id: "c", at: NOW - 30 }),
      item({ id: "d", at: NOW - 40 }),
    ];
    renderBand();
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(screen.getByTestId("ae-model-change-more").textContent).toBe("+ 2 more changes · Show");
    fireEvent.click(screen.getByTestId("ae-model-change-more"));
    expect(lines()).toHaveLength(4);
    expect(screen.queryByTestId("ae-model-change-more")).toBeNull();
  });
});
