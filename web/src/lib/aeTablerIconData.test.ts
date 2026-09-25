// The real lazy chunks: the glob on the installed `@tabler/icons` path must
// find both files, or every `tabler:` icon silently degrades to the folder.

import { describe, expect, it } from "vitest";
import {
  aeTablerIconsIfLoaded,
  loadAeTablerIcons,
  loadAeTablerIconTags,
} from "@/lib/aeTablerIconData";

describe("aeTablerIconData", () => {
  it("loads the outline set once and caches it", async () => {
    expect(aeTablerIconsIfLoaded()).toBeNull();
    const set = await loadAeTablerIcons();
    expect(Object.keys(set).length).toBeGreaterThan(4000);
    expect(set.rocket[0][0]).toBe("path");
    expect(typeof set.rocket[0][1].d).toBe("string");
    expect(aeTablerIconsIfLoaded()).toBe(set);
    expect(await loadAeTablerIcons()).toBe(set);
  });

  it("loads the search tags", async () => {
    const tags = await loadAeTablerIconTags();
    expect(tags.rocket.tags).toContain("space");
  });
});
