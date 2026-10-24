import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AeModelChange, aeUndoModelChange, parseAeModelChange } from "@/lib/aeModelChange";
import { AeModelChangeRow } from "./AeModelChangeRow";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));

afterEach(cleanup);
beforeEach(() => mocks.fetch.mockReset());

const RAISE = {
  status: "changed",
  session_id: "conv_b",
  title: "Fix the sync lock",
  role: "builder",
  is_lead: false,
  from: { model: "sonnet", effort: "medium" },
  to: { model: "opus", effort: "high" },
  kind: "raise",
  raises: 1,
  cap: 1,
  counted: true,
  approved: "auto",
  reason: "Stuck on lock ordering",
  refusal: null,
  undo: { model: "sonnet", effort: "medium" },
};

function change(over: Record<string, unknown> = {}): AeModelChange {
  const parsed = parseAeModelChange(JSON.stringify({ ...RAISE, ...over }));
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

function renderRow(c: AeModelChange) {
  return render(
    <MemoryRouter>
      <AeModelChangeRow change={c} />
    </MemoryRouter>,
  );
}

describe("AeModelChangeRow", () => {
  it("reads a counted raise with an amber up arrow, the count and both buttons", () => {
    renderRow(change());
    expect(screen.getByTestId("ae-model-change-text").textContent).toBe(
      "Raised Builder “Fix the sync lock” from Sonnet medium to Opus high",
    );
    expect(screen.getByTestId("ae-model-change-arrow").getAttribute("data-direction")).toBe("up");
    expect(screen.getByTestId("ae-model-change-arrow").getAttribute("class")).toContain(
      "text-amber-500",
    );
    expect(screen.getByTestId("ae-model-change-why").textContent).toBe(
      "Stuck on lock ordering · raise 1 of 1 automatic",
    );
    expect(screen.getByRole("link", { name: "Open helper" }).getAttribute("href")).toBe(
      "/c/conv_b",
    );
    expect(screen.getByTestId("ae-model-change-undo").textContent).toBe("Undo");
  });

  it("reads a lower with a green down arrow", () => {
    renderRow(
      change({
        kind: "lower",
        counted: false,
        from: { model: "opus", effort: "high" },
        to: { model: "sonnet", effort: "medium" },
      }),
    );
    expect(screen.getByTestId("ae-model-change-arrow").getAttribute("data-direction")).toBe("down");
    expect(screen.getByTestId("ae-model-change-arrow").getAttribute("class")).toContain(
      "text-emerald-500",
    );
    expect(screen.getByTestId("ae-model-change-why").textContent).toBe("Stuck on lock ordering");
  });

  it("says the lead stepped down and offers no helper link", () => {
    renderRow(
      change({
        is_lead: true,
        kind: "lower",
        counted: false,
        title: "Lead",
        role: null,
        from: { model: "opus", effort: "high" },
        to: { model: "sonnet", effort: "medium" },
      }),
    );
    expect(screen.getByTestId("ae-model-change-text").textContent).toBe(
      "Lead stepped down from Opus high to Sonnet medium",
    );
    expect(screen.queryByRole("link", { name: "Open helper" })).toBeNull();
  });

  it.each([
    [true, "raise", "Lead raised itself from Sonnet medium to Opus high"],
    [true, "lower", "Lead stepped down from Sonnet medium to Opus high"],
    [
      false,
      "raise",
      "Raised Builder \u201cFix the sync lock\u201d from Sonnet medium to Opus high",
    ],
    [
      false,
      "lower",
      "Lowered Builder \u201cFix the sync lock\u201d from Sonnet medium to Opus high",
    ],
  ])("words is_lead %s kind %s", (isLead, kind, text) => {
    renderRow(
      change({
        is_lead: isLead,
        kind,
        role: isLead ? null : "builder",
        title: isLead ? "" : "Fix the sync lock",
      }),
    );
    expect(screen.getByTestId("ae-model-change-text").textContent).toBe(text);
    expect(screen.getByTestId("ae-model-change-arrow").getAttribute("data-direction")).toBe(
      kind === "raise" ? "up" : "down",
    );
  });

  it("says approved by you instead of a count", () => {
    renderRow(change({ approved: "reid", counted: true }));
    expect(screen.getByTestId("ae-model-change-why").textContent).toBe(
      "Stuck on lock ordering · approved by you",
    );
  });

  it("undoes with the old values and no caller, then reads Undone and disables", async () => {
    let finish: (res: Response) => void = () => {};
    mocks.fetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    renderRow(change());
    const undo = screen.getByTestId("ae-model-change-undo") as HTMLButtonElement;
    fireEvent.click(undo);
    await waitFor(() => expect(undo.disabled).toBe(true));
    expect(undo.textContent).toBe("Undoing");
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe("/v1/ae/sessions/conv_b/model");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      model: "sonnet",
      effort: "medium",
      undo: true,
      reason: "Undo",
    });
    finish(new Response(JSON.stringify({ status: "changed" }), { status: 200 }));
    await waitFor(() => expect(undo.textContent).toBe("Undone"));
    expect(undo.disabled).toBe(true);
  });

  it("sends null undo values as they are and refuses to read unchanged as undone", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "unchanged" }), { status: 200 }),
    );
    renderRow(change({ undo: { model: null, effort: "low" } }));
    const undo = screen.getByTestId("ae-model-change-undo") as HTMLButtonElement;
    fireEvent.click(undo);
    await waitFor(() =>
      expect(screen.getByTestId("ae-model-change-error").textContent).toBe(
        "Could not undo: nothing changed",
      ),
    );
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({
      model: null,
      effort: "low",
      undo: true,
      reason: "Undo",
    });
    expect(undo.disabled).toBe(false);
    expect(undo.textContent).toBe("Undo");
  });

  it("shows a short error and keeps Undo available when the call fails", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Not your session" } }), { status: 403 }),
    );
    renderRow(change());
    const undo = screen.getByTestId("ae-model-change-undo") as HTMLButtonElement;
    fireEvent.click(undo);
    await waitFor(() =>
      expect(screen.getByTestId("ae-model-change-error").textContent).toBe("Not your session"),
    );
    expect(undo.disabled).toBe(false);
    expect(undo.textContent).toBe("Undo");
  });

  it.each([
    [
      { status: "declined" },
      'Kept the builder "Fix the sync lock" on Sonnet medium (you declined)',
    ],
    [
      { status: "refused", refusal: "The preset forbids changes" },
      "Not changed: The preset forbids changes",
    ],
    [
      { status: "unchanged" },
      'Not changed: the builder "Fix the sync lock" already runs Sonnet medium',
    ],
    [
      { status: "needs_approval" },
      'Waiting for you to approve a change for the builder "Fix the sync lock"',
    ],
  ])("shows one muted line for %j", (over, text) => {
    renderRow(change({ ...over, undo: null }));
    expect(screen.getByTestId("ae-model-change-note").textContent).toBe(text);
    expect(screen.queryByTestId("ae-model-change-undo")).toBeNull();
  });
});

describe("parseAeModelChange", () => {
  it("returns null for output that is not the contract", () => {
    expect(parseAeModelChange(null)).toBeNull();
    expect(parseAeModelChange("plain words")).toBeNull();
    expect(parseAeModelChange("[1]")).toBeNull();
    expect(parseAeModelChange(JSON.stringify({ status: "odd", session_id: "x" }))).toBeNull();
  });

  it("undo throws on a failed response", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 500 }));
    await expect(aeUndoModelChange("s", { model: null, effort: "low" })).rejects.toBeTruthy();
  });
});
