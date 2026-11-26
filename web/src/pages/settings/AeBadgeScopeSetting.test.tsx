import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AeBadgeScopeSetting } from "@/pages/settings/AeBadgeScopeSetting";
import { readAeBadgeScope } from "@/lib/aeBadgeScope";
import { AE_HINT_MAX, aeHint } from "@/lib/aeSettingHints";

describe("AeBadgeScopeSetting", () => {
  beforeEach(() => window.localStorage.clear());

  it("has a hint that names the default and the device, shown as the description", () => {
    render(<AeBadgeScopeSetting />);
    const hint = aeHint("chat.badge_scope");
    expect(hint.trim()).not.toBe("");
    expect(hint.length).toBeLessThanOrEqual(AE_HINT_MAX);
    expect(hint).toMatch(/default/i);
    expect(hint).toMatch(/this device/i);
    expect(screen.getByTestId("ae-badge-scope").textContent).toContain(hint);
    expect(screen.getByRole("button", { name: "About App icon badge counts" })).toBeInTheDocument();
  });

  it("offers both choices, starts on top-level and saves All sessions", () => {
    render(<AeBadgeScopeSetting />);
    expect(screen.getByTestId("ae-badge-scope-top-level").textContent).toContain(
      "Top-level sessions",
    );
    fireEvent.click(screen.getByTestId("ae-badge-scope-all"));
    expect(readAeBadgeScope()).toBe("all");
  });
});
