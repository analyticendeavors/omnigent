import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");

describe("extension page inset in native phone shells", () => {
  // jsdom computes no layout, so this pins the rule that moves the page below
  // the header band, which a native shell floats at safe-top minus 0.5rem.
  it("starts the page below the shifted header band", () => {
    const rule = css.match(
      /@media \(width < 48rem\) \{\s*:is\(\[data-ios-native\], \[data-android-native\]\)\s*main\[data-shell-header="visible"\]\s*\.extension-view-host \{([^}]*)\}/,
    );
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain("var(--omnigent-header-height)");
    expect(rule![1]).toContain("var(--omnigent-safe-top) - 0.5rem");
  });
});
