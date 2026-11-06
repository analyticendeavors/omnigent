import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identity", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({ showToast: vi.fn() }));

import { showToast } from "@/components/ui/toast";
import { authenticatedFetch } from "@/lib/identity";
import {
  AE_COMPACT_POLL_MS,
  cancelAeCompactPlan,
  resetAeCompactPlans,
  startAeCompactPlan,
  useAeCompactPlan,
} from "./aeCompactPlan";

const ID = "conv_1";
const PATH = `/v1/ae/sessions/${ID}/compact`;

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );

const calls = (method: string, tail = "") =>
  vi
    .mocked(authenticatedFetch)
    .mock.calls.filter(
      ([u, init]) => String(u) === PATH + tail && (init?.method ?? "GET") === method,
    );

/** What the next GET answers; the test moves it like the server would. */
const server = { phase: null as string | null, failure: null as unknown };

async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  server.phase = null;
  server.failure = null;
  vi.mocked(authenticatedFetch).mockReset();
  vi.mocked(showToast).mockReset();
  vi.mocked(authenticatedFetch).mockImplementation((_input, init) => {
    if (init?.method === "POST" && String(_input).endsWith("/seen")) return json({ ok: true });
    if (init?.method === "POST") return json({ session_id: ID, phase: "queued" }, 202);
    if (init?.method === "DELETE") return json({ session_id: ID, phase: null });
    return json({ session_id: ID, phase: server.phase, failure: server.failure });
  });
});

afterEach(() => {
  resetAeCompactPlans();
  vi.useRealTimers();
});

describe("aeCompactPlan (thin client)", () => {
  it("POSTs the snooze flag and the hook reads queued", async () => {
    const { result } = renderHook(() => useAeCompactPlan(ID));
    await tick();
    expect(result.current).toBeNull();
    await act(async () => {
      await startAeCompactPlan(ID, { snooze: true });
    });
    expect(result.current).toBe("queued");
    const post = calls("POST")[0]!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ snooze: true });
  });

  it("adopts the phase a 409 names", async () => {
    const { result } = renderHook(() => useAeCompactPlan(ID));
    vi.mocked(authenticatedFetch).mockImplementationOnce(() =>
      json({ error: { code: "ae_compact_queued", message: "queued", phase: "preparing" } }, 409),
    );
    await act(async () => {
      await startAeCompactPlan(ID);
    });
    expect(result.current).toBe("preparing");
  });

  it("rejects with the server's message on a 422", async () => {
    vi.mocked(authenticatedFetch).mockImplementationOnce(() =>
      json({ error: { code: "ae_compact_unsupported", message: "Send /compact instead." } }, 422),
    );
    await expect(startAeCompactPlan(ID)).rejects.toThrow("Send /compact instead.");
  });

  it("polls every 1.5 s through the phases to null, then stops", async () => {
    server.phase = "queued";
    const { result } = renderHook(() => useAeCompactPlan(ID));
    await tick();
    expect(result.current).toBe("queued");
    server.phase = "preparing";
    await tick(AE_COMPACT_POLL_MS);
    expect(result.current).toBe("preparing");
    server.phase = "compacting";
    await tick(AE_COMPACT_POLL_MS);
    expect(result.current).toBe("compacting");
    server.phase = null;
    await tick(AE_COMPACT_POLL_MS);
    expect(result.current).toBeNull();
    const seen = calls("GET").length;
    await tick(AE_COMPACT_POLL_MS * 4);
    expect(calls("GET")).toHaveLength(seen);
  });

  it("toasts a stored failure once and acknowledges it once, over two polls", async () => {
    server.phase = "queued";
    renderHook(() => useAeCompactPlan(ID));
    await tick();
    server.failure = { id: "f1", message: "Compact cancelled: nope.", at: 1 };
    await tick(AE_COMPACT_POLL_MS);
    await tick(AE_COMPACT_POLL_MS);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("Compact cancelled: nope.");
    expect(calls("POST", "/seen")).toHaveLength(1);
    expect(JSON.parse(String(calls("POST", "/seen")[0]![1]?.body))).toEqual({ failure_id: "f1" });
  });

  it("cancel DELETEs and the phase becomes null; a 409 keeps compacting", async () => {
    server.phase = "queued";
    const { result } = renderHook(() => useAeCompactPlan(ID));
    await tick();
    await act(async () => {
      await cancelAeCompactPlan(ID);
    });
    expect(calls("DELETE")).toHaveLength(1);
    expect(result.current).toBeNull();

    vi.mocked(authenticatedFetch).mockImplementationOnce(() =>
      json(
        { error: { code: "ae_compact_sending", message: "going out", phase: "compacting" } },
        409,
      ),
    );
    await act(async () => {
      await cancelAeCompactPlan(ID);
    });
    expect(result.current).toBe("compacting");
  });

  it("two hooks on one id share one poller", async () => {
    server.phase = "queued";
    renderHook(() => useAeCompactPlan(ID));
    renderHook(() => useAeCompactPlan(ID));
    await tick();
    const first = calls("GET").length;
    expect(first).toBe(1);
    await tick(AE_COMPACT_POLL_MS);
    expect(calls("GET")).toHaveLength(first + 1);
  });

  it("resetAeCompactPlans stops the timers", async () => {
    server.phase = "queued";
    renderHook(() => useAeCompactPlan(ID));
    await tick();
    resetAeCompactPlans();
    const seen = calls("GET").length;
    await tick(AE_COMPACT_POLL_MS * 3);
    expect(calls("GET")).toHaveLength(seen);
  });
});
