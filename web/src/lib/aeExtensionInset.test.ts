import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");
const NATIVE = ":is\\(\\[data-ios-native\\], \\[data-android-native\\]\\)";
const VISIBLE = 'main\\[data-shell-header="visible"\\]';

// jsdom computes no layout, so this pins the rules that move an extension page
// below the header band a native shell floats at safe-top minus 0.5rem. The real
// check is the hit test at 390 and 820 px in the PR body.
describe("extension page inset in native shells", () => {
  it("defines the offset for the phone header (3.5rem) and the wide header (3rem)", () => {
    const phone = css.match(
      new RegExp(`${NATIVE}\\s*${VISIBLE}\\s*\\{\\s*--ae-extension-top:\\s*([^;]*);`),
    );
    expect(phone?.[1]).toContain("3.5rem");
    expect(phone?.[1]).toContain("var(--omnigent-safe-top) - 0.5rem");
    const wide = css.match(
      new RegExp(
        `@media \\(width >= 48rem\\) \\{\\s*${NATIVE}\\s*${VISIBLE}\\s*\\{\\s*--ae-extension-top:\\s*([^;]*);`,
      ),
    );
    expect(wide?.[1]).toContain("3rem");
    expect(wide?.[1]).toContain("var(--omnigent-safe-top) - 0.5rem");
  });

  it("starts the page and its loading overlay at that offset, with no width gate", () => {
    for (const target of ["extension-view-host", "extension-view-status"]) {
      const rule = css.match(
        new RegExp(`${NATIVE}\\s*${VISIBLE}\\s*\\.${target}\\s*\\{([^}]*)\\}`),
      );
      expect(rule?.[1]).toContain("var(--ae-extension-top)");
    }
    // Top-level rules: neither sits inside a width-gated media block.
    expect(css).not.toMatch(/@media \(width < 48rem\) \{[^}]*\.extension-view-(host|status)/);
  });
});
