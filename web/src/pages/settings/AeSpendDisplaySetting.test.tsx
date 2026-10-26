import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AeSpendDisplaySetting } from "@/pages/settings/AeSpendDisplaySetting";
import { readAeSpendDisplay } from "@/lib/aeSpendDisplay";

describe("AeSpendDisplaySetting", () => {
  beforeEach(() => window.localStorage.clear());

  it("describes every choice in its one description line and in the phone tooltip", () => {
    render(<AeSpendDisplaySetting />);
    expect(screen.getByRole("button", { name: "About Spend shows" })).toBeInTheDocument();
    const line = screen.getByTestId("ae-spend-display").textContent ?? "";
    for (const word of ["Tokens", "Cost", "Both", "Off"]) expect(line).toContain(word);
  });

  it("offers Both and saves it", () => {
    render(<AeSpendDisplaySetting />);
    for (const mode of ["tokens", "cost", "both", "off"]) {
      expect(screen.getByTestId(`ae-spend-display-${mode}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("ae-spend-display-both"));
    expect(readAeSpendDisplay()).toBe("both");
  });
});
