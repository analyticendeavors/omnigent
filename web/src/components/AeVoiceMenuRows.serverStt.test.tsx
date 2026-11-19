// @vitest-environment jsdom
// "Transcribe on the box" menu row: only on iPhone or iPad, and only when the server has dictation.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilitiesContext } from "@/lib/CapabilitiesContext";
import type { ServerInfo } from "@/lib/capabilities";
import { VOICE_SERVER_STT_KEY } from "@/lib/aeVoiceServerStt";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VoiceServerSttRow } from "./AeVoiceMenuRows";

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const INFO_ON = { dictation_available: true } as unknown as ServerInfo;
const INFO_OFF = { dictation_available: false } as unknown as ServerInfo;
let originalUa: PropertyDescriptor | undefined;

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
}

async function open(dictation: boolean) {
  const info = dictation ? INFO_ON : INFO_OFF;
  render(
    <CapabilitiesContext.Provider value={info}>
      <DropdownMenu>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <VoiceServerSttRow />
        </DropdownMenuContent>
      </DropdownMenu>
    </CapabilitiesContext.Provider>,
  );
  await userEvent.setup().click(screen.getByText("menu"));
}

beforeEach(() => {
  originalUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  window.localStorage.removeItem(VOICE_SERVER_STT_KEY);
});
afterEach(() => {
  window.localStorage.removeItem(VOICE_SERVER_STT_KEY);
  if (originalUa) Object.defineProperty(navigator, "userAgent", originalUa);
  else delete (navigator as { userAgent?: unknown }).userAgent;
});

describe("VoiceServerSttRow", () => {
  it("shows on iOS with dictation available, on by default, and toggles", async () => {
    setUserAgent(IOS_UA);
    await open(true);
    const row = screen.getByTestId("ae-voice-server-stt");
    expect(row.getAttribute("aria-checked")).toBe("true");
    expect(row.textContent).toContain("Transcribe on the box");
    await userEvent.setup().click(row);
    expect(window.localStorage.getItem(VOICE_SERVER_STT_KEY)).toBe("off");
  });

  it("is hidden on iOS when the server has no dictation", async () => {
    setUserAgent(IOS_UA);
    await open(false);
    expect(screen.queryByTestId("ae-voice-server-stt")).toBeNull();
  });

  it("is hidden off iOS", async () => {
    setUserAgent(CHROME_UA);
    await open(true);
    expect(screen.queryByTestId("ae-voice-server-stt")).toBeNull();
  });
});
