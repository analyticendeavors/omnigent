import { describe, expect, it, vi } from "vitest";
import { syncAeAppBadge } from "./aeAppBadge";

describe("syncAeAppBadge", () => {
  it("sets the count and clears it at zero", () => {
    const setAppBadge = vi.fn(async () => undefined);
    const clearAppBadge = vi.fn(async () => undefined);
    const nav = { setAppBadge, clearAppBadge } as unknown as Navigator;
    syncAeAppBadge(2, nav);
    expect(setAppBadge).toHaveBeenCalledWith(2);
    syncAeAppBadge(0, nav);
    expect(clearAppBadge).toHaveBeenCalled();
  });

  it("does nothing without the Badging API and swallows a refusal", async () => {
    expect(() => syncAeAppBadge(3, {} as Navigator)).not.toThrow();
    const setAppBadge = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    syncAeAppBadge(3, { setAppBadge } as unknown as Navigator);
    await Promise.resolve();
    expect(setAppBadge).toHaveBeenCalledWith(3);
  });
});
