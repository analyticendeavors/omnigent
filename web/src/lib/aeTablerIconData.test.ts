// The real JSON assets: the glob on the installed `@tabler/icons` path must
// find both files, or every `tabler:` icon silently degrades to the folder.
// `fetch` is served from disk, so the URLs the loaders ask for are checked too.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  aeTablerIconsIfLoaded,
  loadAeTablerIcons,
  loadAeTablerIconTags,
  subscribeAeTablerIcons,
} from "@/lib/aeTablerIconData";

const requested: string[] = [];
let failNext = false;

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (failNext) {
        failNext = false;
        // Safari's wording for a dropped connection.
        return Promise.reject(new TypeError("Load failed"));
      }
      // Vite's dev URL: `/@fs/<absolute path>` outside the root, else root-relative.
      const path = url.split("?")[0];
      const file = path.startsWith("/@fs/") ? path.slice("/@fs".length) : `.${path}`;
      return Promise.resolve(new Response(readFileSync(file)));
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("aeTablerIconData", () => {
  it("retries a failed load under a new URL, then loads once and caches", async () => {
    const heard = vi.fn();
    const unsubscribe = subscribeAeTablerIcons(heard);
    failNext = true;
    await expect(loadAeTablerIcons()).rejects.toThrow("Load failed");
    expect(aeTablerIconsIfLoaded()).toBeNull();
    expect(heard).not.toHaveBeenCalled();

    const set = await loadAeTablerIcons();
    expect(requested).toHaveLength(2);
    expect(requested[0]).toMatch(/tabler-nodes-outline\.json$/);
    // Not the same URL again: a browser that cached the failure must refetch.
    expect(requested[1]).toBe(`${requested[0]}?retry=1`);
    expect(heard).toHaveBeenCalledWith(set);
    unsubscribe();

    expect(Object.keys(set).length).toBeGreaterThan(4000);
    expect(set.rocket[0][0]).toBe("path");
    expect(typeof set.rocket[0][1].d).toBe("string");
    expect(aeTablerIconsIfLoaded()).toBe(set);
    expect(await loadAeTablerIcons()).toBe(set);
    expect(requested).toHaveLength(2);
  });

  it("loads the search tags, retrying under a new URL", async () => {
    requested.length = 0;
    failNext = true;
    await expect(loadAeTablerIconTags()).rejects.toThrow("Load failed");
    const tags = await loadAeTablerIconTags();
    expect(requested[0]).toMatch(/icons\.json$/);
    expect(requested[1]).toBe(`${requested[0]}?retry=1`);
    expect(tags.rocket.tags).toContain("space");
  });
});
