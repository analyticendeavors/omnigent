import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AE_SETTING_HINTS } from "@/lib/aeSettingHints";
import { AeHint } from "./AeHint";

afterEach(cleanup);

const TEXT = AE_SETTING_HINTS["insights.run_now"].hint;

function setup() {
  render(
    <div>
      <p data-testid="outside">outside</p>
      <AeHint id="insights.run_now" />
    </div>,
  );
  return {
    user: userEvent.setup({
      pointerMap: [
        { name: "mouse", pointerType: "mouse" },
        { name: "touch", pointerType: "touch" },
      ],
    }),
    button: screen.getByRole("button", { name: "About Run now" }),
  };
}

type User = ReturnType<typeof setup>["user"];
/** One finger tap: pointer down, up, then click, as a phone sends them. */
const tap = (user: User, target: Element) => user.pointer({ keys: "[touch]", target });

describe("AeHint", () => {
  it("shows its text when the icon takes keyboard focus", async () => {
    render(<AeHint id="rules.helpers" />);
    const button = screen.getByRole("button", { name: "About Helpers" });
    act(() => button.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      AE_SETTING_HINTS["rules.helpers"].hint,
    );
  });

  it("keeps the text open when a mouse clicks the icon it hovered open", async () => {
    const { user, button } = setup();
    await user.click(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(TEXT);
  });

  it("opens on a tap (pointer down, up, click) and names the text as its description", async () => {
    const { user, button } = setup();
    await tap(user, button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(TEXT);
    expect(button).toHaveAttribute("data-state", expect.stringMatching(/open/));
    expect(button).toHaveAttribute("aria-describedby");
  });

  it("closes on a second tap and stays closed", async () => {
    const { user, button } = setup();
    await tap(user, button);
    await screen.findByRole("tooltip");
    await tap(user, button);
    expect(button).toHaveAttribute("data-state", "closed");
    expect(button).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes on a tap outside", async () => {
    const { user, button } = setup();
    await tap(user, button);
    await screen.findByRole("tooltip");
    await tap(user, screen.getByTestId("outside"));
    expect(button).toHaveAttribute("data-state", "closed");
  });

  it("closes on Escape", async () => {
    const { user, button } = setup();
    await tap(user, button);
    await screen.findByRole("tooltip");
    await user.keyboard("{Escape}");
    expect(button).toHaveAttribute("data-state", "closed");
  });

  it("opens again on a third tap", async () => {
    const { user, button } = setup();
    await tap(user, button);
    await tap(user, button);
    await tap(user, button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(TEXT);
  });
});
