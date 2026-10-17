// Tests for the Triage section's pure parts: the absorbed and unfiled lines,
// the turn count, the started line, the overflow tag, and the gate reply.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyBlock, BlockContext } from "@/lib/blocks";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));

import {
  aeOrdinal,
  aeOverflowTag,
  aeStartedLine,
  countAeUserTurns,
  fetchAeLotTasks,
  formatAeAge,
  parseAeStarted,
  replyAeGate,
  scanAeTriageLines,
} from "./aeRailTriage";

const ctx: BlockContext = {
  agent: null,
  depth: 0,
  turn: 0,
  timestamp: 0,
  responseId: "r",
  itemId: null,
};

function said(text: string): AnyBlock {
  return { type: "text_done", ctx, fullText: text, hasCodeBlocks: false };
}

function asked(text: string): AnyBlock {
  return { type: "user_message", ctx, content: [{ type: "input_text", text }] };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => mocks.fetch.mockReset());

describe("scanAeTriageLines", () => {
  it("reads tokens at the start of a line only, from assistant text only", () => {
    const blocks = [
      said("Done.\nAbsorbed: Tabler icon for the rail button, same file\nmore"),
      said("We said Absorbed: inside prose, which is not a marker."),
      said("UNFILED (target unreachable), file this yourself\r\nTHREAD: x"),
      asked("Absorbed: typed by the human"),
      said("Absorbed:   Phone frame for the popover  "),
    ];
    expect(scanAeTriageLines(blocks)).toEqual({
      absorbed: ["Tabler icon for the rail button, same file", "Phone frame for the popover"],
      unfiled: ["(target unreachable), file this yourself"],
    });
  });

  it("keeps the token for a bare line and is empty with nothing loaded", () => {
    expect(scanAeTriageLines([said("UNFILED")]).unfiled).toEqual(["UNFILED"]);
    expect(scanAeTriageLines([])).toEqual({ absorbed: [], unfiled: [] });
  });
});

describe("countAeUserTurns", () => {
  it("counts user messages and leaves out system markers", () => {
    expect(countAeUserTurns([asked("one"), said("reply"), asked("two")])).toBe(2);
    expect(countAeUserTurns([asked("[System: the runner restarted]")])).toBe(0);
  });
});

describe("the started line", () => {
  it("parses ae.started and rejects blanks and junk", () => {
    expect(parseAeStarted("1760000000")).toBe(1760000000);
    expect(parseAeStarted(null)).toBeNull();
    expect(parseAeStarted("soon")).toBeNull();
    expect(parseAeStarted("0")).toBeNull();
  });

  it("formats ages", () => {
    expect(formatAeAge(30)).toBe("just now");
    expect(formatAeAge(5 * 60)).toBe("5m");
    expect(formatAeAge(2 * 3600 + 10 * 60)).toBe("2h 10m");
    expect(formatAeAge(3 * 3600)).toBe("3h");
    expect(formatAeAge(3 * 86400 + 4 * 3600)).toBe("3d 4h");
  });

  it("joins the age and the turns, either alone, or nothing", () => {
    const now = 10_000_000 * 1000;
    const started = 10_000_000 - (2 * 3600 + 10 * 60);
    expect(aeStartedLine(started, now, 41)).toBe("Started 2h 10m ago · 41 turns");
    expect(aeStartedLine(started, now, null)).toBe("Started 2h 10m ago");
    expect(aeStartedLine(null, now, 1)).toBe("1 turn");
    expect(aeStartedLine(null, now, 12, true)).toBeNull();
    expect(aeStartedLine(started, now, 12, true)).toBe("Started 2h 10m ago");
    expect(aeStartedLine(null, now, null)).toBeNull();
  });
});

describe("the overflow tag", () => {
  it("names the place past the limit", () => {
    expect(aeOrdinal(4)).toBe("4th");
    expect(aeOrdinal(2)).toBe("2nd");
    expect(aeOrdinal(11)).toBe("11th");
    expect(aeOrdinal(22)).toBe("22nd");
    expect(aeOverflowTag(3)).toEqual({
      label: "4th working",
      title: "Started while three sessions were already working",
    });
  });
});

describe("replyAeGate", () => {
  it("posts the route to the gate reply route", async () => {
    mocks.fetch.mockResolvedValue(json(200, { posted: true }));
    await replyAeGate("conv a", "C");
    expect(mocks.fetch).toHaveBeenCalledWith("/v1/ae/gate/conv%20a/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: "C" }),
    });
  });

  it("throws the server's message", async () => {
    mocks.fetch.mockResolvedValue(
      json(409, { error: { code: "conflict", message: "no open gate on session s1" } }),
    );
    await expect(replyAeGate("s1", "A")).rejects.toThrow("no open gate on session s1");
  });

  it("falls back to the status line without a JSON body", async () => {
    mocks.fetch.mockResolvedValue(new Response("boom", { status: 502, statusText: "Bad Gateway" }));
    await expect(replyAeGate("s1", "close")).rejects.toThrow("502 Bad Gateway");
  });
});

describe("fetchAeLotTasks", () => {
  it("keeps id, title and link, and drops rows without an id", async () => {
    mocks.fetch.mockResolvedValue(
      json(200, {
        tasks: [{ id: "t1", title: "Parked thing", url: "https://tasks.example/#/all?q=x" }, {}],
      }),
    );
    await expect(fetchAeLotTasks()).resolves.toEqual([
      { id: "t1", title: "Parked thing", url: "https://tasks.example/#/all?q=x" },
    ]);
  });

  it("throws what the lot route said", async () => {
    mocks.fetch.mockResolvedValue(
      json(503, { error: { code: "not_configured", message: "task-store is not configured" } }),
    );
    await expect(fetchAeLotTasks()).rejects.toThrow("task-store is not configured");
  });
});
