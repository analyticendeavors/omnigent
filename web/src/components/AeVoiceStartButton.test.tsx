import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeSpeech, removeFakeSpeech } from "@/test/fakeSpeech";
import { AeVoiceStartButton } from "./AeVoiceStartButton";

beforeEach(() => installFakeSpeech());
afterEach(() => removeFakeSpeech());

describe("AeVoiceStartButton", () => {
  it("renders the button and reports a tap", async () => {
    const onToggle = vi.fn();
    render(<AeVoiceStartButton armed={false} onToggle={onToggle} />);
    const btn = screen.getByTestId("ae-voice-start");
    expect(btn.getAttribute("aria-label")).toBe("Voice mode");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("is pressed while armed", () => {
    render(<AeVoiceStartButton armed onToggle={() => {}} />);
    expect(screen.getByTestId("ae-voice-start").getAttribute("aria-pressed")).toBe("true");
  });

  it("renders nothing when speech is unsupported", () => {
    removeFakeSpeech();
    render(<AeVoiceStartButton armed={false} onToggle={() => {}} />);
    expect(screen.queryByTestId("ae-voice-start")).toBeNull();
  });
});
