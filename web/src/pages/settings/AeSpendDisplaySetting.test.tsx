import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AeSpendDisplaySetting } from "@/pages/settings/AeSpendDisplaySetting";
import { readAeSpendDisplay } from "@/lib/aeSpendDisplay";

describe("AeSpendDisplaySetting", () => {
  beforeEach(() => window.localStorage.clear());

  it("offers Both and saves it", () => {
    render(<AeSpendDisplaySetting />);
    for (const mode of ["tokens", "cost", "both", "off"]) {
      expect(screen.getByTestId(`ae-spend-display-${mode}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId("ae-spend-display-both"));
    expect(readAeSpendDisplay()).toBe("both");
  });
});
