// Tests for the fast mode store and model gate (omnigent-ae, 2026-10-14).

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/identity", () => ({ authenticatedFetch: mocks.fetch }));

import {
  aeFastModeModelSupported,
  aeFastModePath,
  changeAeFastMode,
  fetchAeFastMode,
  opusVersion,
  putAeFastMode,
  refreshAeFastMode,
  resetAeFastModeStore,
  useAeFastMode,
} from "./aeFastMode";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mocks.fetch.mockReset();
  resetAeFastModeStore();
});
afterEach(() => vi.useRealTimers());

describe("opusVersion", () => {
  it.each([
    ["claude-opus-5-5", "5.5"],
    ["claude-opus-5-5[1m]", "5.5"],
    ["claude-opus-5", "5"],
    ["claude-opus-5-20261001", "5"],
    ["claude-opus-4-8", "4.8"],
    ["us.anthropic.claude-opus-4-8-v1:0", "4.8"],
    ["claude-opus-4-1", "4.1"],
    ["Opus 5.5", "5.5"],
    ["Opus 4.8 (1M context)", "4.8"],
    ["Claude Opus 5", "5"],
    ["claude-3-opus-20240229", "20240229"],
    ["opus", null],
    ["claude-sonnet-5", null],
    ["default", null],
    ["", null],
    [null, null],
  ])("reads %s as %s", (value, version) => {
    expect(opusVersion(value)).toBe(version);
  });
});

describe("aeFastModeModelSupported", () => {
  it("takes Opus 5.5, 5 and 4.8 from any spelling", () => {
    expect(aeFastModeModelSupported("claude-opus-5-5")).toBe(true);
    expect(aeFastModeModelSupported("claude-opus-5")).toBe(true);
    expect(aeFastModeModelSupported("claude-opus-4-8[1m]")).toBe(true);
    expect(aeFastModeModelSupported("opus", "Opus 5.5")).toBe(true);
  });

  it("refuses everything else", () => {
    expect(aeFastModeModelSupported("claude-opus-4-1", "Opus 4.1")).toBe(false);
    expect(aeFastModeModelSupported("claude-sonnet-5", "Sonnet 5")).toBe(false);
    expect(aeFastModeModelSupported("opus", null)).toBe(false);
    expect(aeFastModeModelSupported(null, undefined)).toBe(false);
  });
});

describe("requests", () => {
  it("encodes the session id into the path", () => {
    expect(aeFastModePath("conv 1/2")).toBe("/v1/sessions/conv%201%2F2/fast-mode");
  });

  it("reads null as unknown and throws the server's reason", async () => {
    mocks.fetch.mockResolvedValueOnce(json(200, { enabled: null }));
    await expect(fetchAeFastMode("c")).resolves.toBeNull();
    mocks.fetch.mockResolvedValueOnce(json(409, { error: { message: "not Claude" } }));
    await expect(fetchAeFastMode("c")).rejects.toThrow("not Claude");
  });

  it("refuses a change answer without a state", async () => {
    mocks.fetch.mockResolvedValueOnce(json(200, {}));
    await expect(putAeFastMode("c", true)).rejects.toThrow("without a fast mode state");
  });
});

describe("store", () => {
  it("drops a read that started before a change", async () => {
    let answerRead!: (response: Response) => void;
    mocks.fetch.mockImplementation((_path: string, init: RequestInit) =>
      init.method === "PUT"
        ? Promise.resolve(json(200, { enabled: true }))
        : new Promise<Response>((resolve) => {
            answerRead = resolve;
          }),
    );
    const { result } = renderHook(() => useAeFastMode("c"));

    const read = refreshAeFastMode("c");
    await changeAeFastMode("c", true);
    answerRead(json(200, { enabled: false }));
    await read;

    expect(result.current).toEqual({ enabled: true, pending: null, error: null, settled: true });
  });

  it("keeps sessions apart and ignores a second change while one runs", async () => {
    let finish!: (response: Response) => void;
    mocks.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const first = changeAeFastMode("a", true);
    await changeAeFastMode("a", false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    const { result } = renderHook(() => [useAeFastMode("a"), useAeFastMode("b")]);
    expect(result.current[0].pending).toBe(true);
    expect(result.current[1]).toEqual({
      enabled: null,
      pending: null,
      error: null,
      settled: false,
    });
    finish(json(200, { enabled: true }));
    await first;
  });

  it("falls back to a plain reason when the failure has none", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error(""));
    await changeAeFastMode("c", false);
    const { result } = renderHook(() => useAeFastMode("c"));
    expect(result.current.error).toBe("Could not turn fast mode off.");
    expect(result.current.pending).toBeNull();
  });
});
