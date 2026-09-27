// The real loader against the installed `@tabler/icons` files: the glob must
// find both, or every `tabler:` icon silently degrades to the folder. The test
// setup serves them from disk (`aeTablerAssetFetch.disk.ts`); each case loads a
// fresh copy of the module, so failures and retries start from nothing.

import { afterEach, describe, expect, it, vi } from "vitest";

async function freshLoader() {
  vi.resetModules();
  const data = await import("@/lib/aeTablerIconData");
  const { fetchAeTablerAsset } = await import("@/lib/aeTablerAssetFetch");
  const fetch = vi.mocked(fetchAeTablerAsset);
  fetch.mockClear();
  const urls = () => fetch.mock.calls.map(([url]) => url);
  const failNext = () => fetch.mockRejectedValueOnce(new TypeError("Load failed"));
  return { data, fetch, urls, failNext };
}

const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("aeTablerRetryUrl", () => {
  it("adds a retry query to an http URL and never to a data: or blob: URL", async () => {
    const { aeTablerRetryUrl } = await import("@/lib/aeTablerIconData");
    expect(aeTablerRetryUrl("/assets/a.json", 0)).toBe("/assets/a.json");
    expect(aeTablerRetryUrl("/assets/a.json", 2)).toBe("/assets/a.json?retry=2");
    expect(aeTablerRetryUrl("/assets/a.json?v=1", 1)).toBe("/assets/a.json?v=1&retry=1");
    expect(aeTablerRetryUrl("data:application/json;base64,e30=", 3)).toBe(
      "data:application/json;base64,e30=",
    );
    expect(aeTablerRetryUrl("blob:https://x/1", 1)).toBe("blob:https://x/1");
  });
});

describe("aeTablerIconData", () => {
  it("retries a failed load under a new URL, then loads once and caches", async () => {
    const { data, urls, failNext } = await freshLoader();
    failNext();
    await expect(data.loadAeTablerIcons()).rejects.toThrow("Load failed");
    expect(data.aeTablerIconsIfLoaded()).toBeNull();
    expect(data.aeTablerIconsState()).toBe("error");

    const set = await data.loadAeTablerIcons();
    expect(urls()).toHaveLength(2);
    expect(urls()[0]).toMatch(/tabler-nodes-outline\.json(\?|$)/);
    // Not the same URL again: a browser that cached the failure must refetch.
    expect(urls()[1]).toBe(data.aeTablerRetryUrl(urls()[0], 1));
    expect(Object.keys(set).length).toBeGreaterThan(4000);
    expect(set.rocket[0][0]).toBe("path");
    expect(typeof set.rocket[0][1].d).toBe("string");
    expect(data.aeTablerIconsState()).toBe(set);
    expect(await data.loadAeTablerIcons()).toBe(set);
    expect(urls()).toHaveLength(2);
  });

  it("loads the search tags, retrying under a new URL", async () => {
    const { data, urls, failNext } = await freshLoader();
    failNext();
    await expect(data.loadAeTablerIconTags()).rejects.toThrow("Load failed");
    const tags = await data.loadAeTablerIconTags();
    expect(urls()[0]).toMatch(/\/icons\.json(\?|$)/);
    expect(urls()[1]).toBe(data.aeTablerRetryUrl(urls()[0], 1));
    expect(tags.rocket.tags).toContain("space");
  });

  it("starts the load for the first subscriber and tells it once the set is in", async () => {
    const { data, fetch } = await freshLoader();
    const heard = vi.fn();
    data.subscribeAeTablerIcons(heard);
    data.subscribeAeTablerIcons(vi.fn());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(data.aeTablerIconsState()).toBeNull();
    await data.loadAeTablerIcons();
    await settle();
    expect(data.aeTablerIconsState()).not.toBeNull();
    expect(heard).toHaveBeenCalled();
  });

  it("keeps a good load when a listener throws", async () => {
    const { data } = await freshLoader();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const after = vi.fn();
    data.subscribeAeTablerIcons(() => {
      if (data.aeTablerIconsIfLoaded()) throw new Error("listener broke");
    });
    data.subscribeAeTablerIcons(after);
    const set = await data.loadAeTablerIcons();
    await settle();
    expect(data.aeTablerIconsIfLoaded()).toBe(set);
    expect(after).toHaveBeenCalled();
    // The promise stays resolved: a second call returns the same set, no refetch.
    await expect(data.loadAeTablerIcons()).resolves.toBe(set);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("retries for a new subscriber once the backoff has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { data, fetch, urls, failNext } = await freshLoader();
    failNext();
    const heard = vi.fn();
    data.subscribeAeTablerIcons(heard);
    await settle();
    expect(data.aeTablerIconsState()).toBe("error");
    // Right after the failure: no loop.
    data.subscribeAeTablerIcons(vi.fn());
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2000);
    data.subscribeAeTablerIcons(vi.fn());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(urls()[1]).toMatch(/[?&]retry=1$/);
    await vi.waitFor(() => expect(data.aeTablerIconsIfLoaded()).not.toBeNull());
    expect(heard).toHaveBeenCalled();
  });

  it("retries when the browser comes back online", async () => {
    const { data, fetch, failNext } = await freshLoader();
    failNext();
    data.subscribeAeTablerIcons(vi.fn());
    await settle();
    expect(data.aeTablerIconsState()).toBe("error");
    window.dispatchEvent(new Event("online"));
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(data.aeTablerIconsIfLoaded()).not.toBeNull());
  });
});
