import { AE_SETTING_HINTS } from "@/lib/aeSettingHints";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCloudVoicesCache } from "@/lib/aeCloudVoice";
import {
  getVoiceSnapshot,
  resetVoiceStore,
  setVoiceOn,
  setVoiceBlocked,
  setVoicePhase,
  stopVoice,
} from "@/lib/aeVoiceMode";
import { resetSnipsStore } from "@/lib/aeVoiceSnips";
import { useChatStore } from "@/store/chatStore";
import { installFakeSpeech, makeVoice, removeFakeSpeech } from "@/test/fakeSpeech";
import { AeSpeakRepliesButton } from "./AeSpeakRepliesButton";

const setEffort = vi.fn(() => Promise.resolve());
const originalSetEffort = useChatStore.getState().setEffort;

function Button(props: Partial<React.ComponentProps<typeof AeSpeakRepliesButton>>) {
  return <AeSpeakRepliesButton chatId="c1" canSetEffort currentEffort="high" {...props} />;
}

function renderButton(props: Partial<React.ComponentProps<typeof AeSpeakRepliesButton>> = {}) {
  return render(<Button {...props} />);
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("ae-speak-replies-menu"));
  return user;
}

const CLOUD = [
  { id: "en-US-AvaMultilingualNeural", name: "Ava" },
  { id: "en-US-AndrewMultilingualNeural", name: "Andrew" },
];

function serveCloudVoices(voices: { id: string; name: string }[]) {
  resetCloudVoicesCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ voices }), { status: 200 }))),
  );
}

beforeEach(() => {
  serveCloudVoices([]);
  window.localStorage.clear();
  resetSnipsStore();
  resetVoiceStore();
  setEffort.mockClear();
  useChatStore.setState({ conversationId: "c1", blocks: [], status: "idle", setEffort } as never);
  const synth = installFakeSpeech();
  synth.voices = [
    makeVoice({ name: "Plain", lang: "en-US", default: true }),
    makeVoice({
      name: "Microsoft Aria Online (Natural) - English",
      lang: "en-US",
      voiceURI: "aria",
    }),
  ];
  Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  removeFakeSpeech();
  useChatStore.setState({ setEffort: originalSetEffort } as never);
});

function mediaDevicesForLayout() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices: () => Promise.resolve([]), addEventListener: () => {} },
  });
  (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId = vi.fn();
}

describe("AeSpeakRepliesButton", () => {
  afterEach(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
  });

  it("renders nothing without the speech api", () => {
    removeFakeSpeech();
    const { container } = renderButton();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without a chat id", () => {
    const { container } = renderButton({ chatId: null });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the trigger, off by default", () => {
    renderButton();
    const trigger = screen.getByTestId("ae-speak-replies");
    expect(trigger).toHaveAttribute("aria-pressed", "false");
    expect(trigger).toHaveAttribute("title", "Speak replies: off");
  });

  it("shows the four hint controls and no description lines", async () => {
    renderButton();
    await openMenu();
    for (const id of ["voice.speak", "voice.fast", "voice.voice", "voice.rate"]) {
      expect(screen.getByTestId(`ae-hint-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByText(/Reads each reply in this chat aloud/)).toBeNull();
  });

  it("shows an off row as an unchecked switch and turns on when the row is clicked", async () => {
    renderButton();
    const user = await openMenu();
    const row = screen.getByTestId("ae-speak-toggle");
    expect(within(row).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await user.click(row);
    expect(window.localStorage.getItem("omnigent:ae-speak-replies:c1")).toBe("true");
    expect(within(screen.getByTestId("ae-speak-toggle")).getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("ae-speak-fast")).toBeInTheDocument();
  });

  it("does not toggle the row when its hint is pressed", async () => {
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-hint-voice.speak"));
    expect(window.localStorage.getItem("omnigent:ae-speak-replies:c1")).toBeNull();
    expect(screen.getByTestId("ae-speak-toggle")).toBeInTheDocument();
  });

  it("turns on, lowers the effort and remembers the old one, then restores it", async () => {
    const view = renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-toggle"));
    expect(window.localStorage.getItem("omnigent:ae-speak-replies:c1")).toBe("true");
    await waitFor(() => expect(setEffort).toHaveBeenLastCalledWith("low"));
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("omnigent:ae-speak-fast:c1") ?? "null"),
      ).toEqual({
        previousEffort: "high",
      }),
    );
    expect(screen.getByTestId("ae-speak-replies")).toHaveAttribute("aria-pressed", "true");

    view.rerender(<Button currentEffort="low" />);
    await user.click(screen.getByTestId("ae-speak-toggle"));
    await waitFor(() => expect(setEffort).toHaveBeenLastCalledWith("high"));
    await waitFor(() =>
      expect(window.localStorage.getItem("omnigent:ae-speak-fast:c1")).toBeNull(),
    );
    expect(window.localStorage.getItem("omnigent:ae-speak-replies:c1")).toBeNull();
  });

  it("stores nothing when lowering the effort is rejected", async () => {
    setEffort.mockRejectedValueOnce(new Error("no"));
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-toggle"));
    await waitFor(() => expect(setEffort).toHaveBeenCalledWith("low"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(window.localStorage.getItem("omnigent:ae-speak-fast:c1")).toBeNull();
    expect(screen.getByTestId("ae-speak-replies")).toHaveAttribute("aria-pressed", "true");
  });

  it("restores a null effort", async () => {
    const view = renderButton({ currentEffort: null });
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-toggle"));
    await waitFor(() =>
      expect(window.localStorage.getItem("omnigent:ae-speak-fast:c1")).toBe(
        '{"previousEffort":null}',
      ),
    );
    view.rerender(<Button currentEffort="low" />);
    await user.click(screen.getByTestId("ae-speak-toggle"));
    await waitFor(() => expect(setEffort).toHaveBeenLastCalledWith(null));
  });

  it("leaves an effort the user changed by hand", async () => {
    const view = renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-toggle"));
    await waitFor(() =>
      expect(window.localStorage.getItem("omnigent:ae-speak-fast:c1")).not.toBeNull(),
    );
    setEffort.mockClear();
    view.rerender(<Button currentEffort="high" />);
    await user.click(screen.getByTestId("ae-speak-toggle"));
    await waitFor(() =>
      expect(window.localStorage.getItem("omnigent:ae-speak-fast:c1")).toBeNull(),
    );
    expect(setEffort).not.toHaveBeenCalled();
  });

  it("keeps the stored state when restoring is rejected", async () => {
    const view = renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-toggle"));
    await waitFor(() =>
      expect(window.localStorage.getItem("omnigent:ae-speak-fast:c1")).not.toBeNull(),
    );
    view.rerender(<Button currentEffort="low" />);
    setEffort.mockRejectedValueOnce(new Error("no"));
    await user.click(screen.getByTestId("ae-speak-toggle"));
    await waitFor(() => expect(setEffort).toHaveBeenLastCalledWith("high"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(window.localStorage.getItem("omnigent:ae-speak-fast:c1")).not.toBeNull();
  });

  it("shows Send snips off by default, saves the switch and has a hint", async () => {
    renderButton();
    const user = await openMenu();
    const row = screen.getByTestId("ae-voice-snips");
    expect(row).toHaveAttribute("aria-checked", "false");
    expect(within(row).getByTestId("ae-hint-voice.snips")).toBeInTheDocument();
    await user.click(row);
    expect(screen.getByTestId("ae-voice-snips")).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem("omnigent:ae-voice-snips")).toBe("true");
  });

  it("has a Mic while speaking row, default wait, saved per device, with a hint", async () => {
    renderButton();
    const user = await openMenu();
    const row = screen.getByTestId("ae-voice-mic-while-speaking");
    expect(row).toHaveAttribute("aria-checked", "false");
    expect(within(row).getByTestId("ae-hint-voice.mic_while_speaking")).toBeInTheDocument();
    expect(AE_SETTING_HINTS["voice.mic_while_speaking"].hint.trim()).not.toBe("");
    await user.click(row);
    expect(screen.getByTestId("ae-voice-mic-while-speaking")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(window.localStorage.getItem("omnigent:ae-voice-mic-while-speaking")).toBe("always");
    await user.click(screen.getByTestId("ae-voice-mic-while-speaking"));
    expect(window.localStorage.getItem("omnigent:ae-voice-mic-while-speaking")).toBeNull();
  });

  it("applies Fast answers once effort levels arrive", async () => {
    window.localStorage.setItem("omnigent:ae-speak-replies:c1", "true");
    const view = renderButton({ canSetEffort: false });
    expect(setEffort).not.toHaveBeenCalled();
    view.rerender(<Button canSetEffort />);
    await waitFor(() => expect(setEffort).toHaveBeenCalledWith("low"));
  });

  it("hides Fast answers in a read-only chat but keeps the trigger enabled", async () => {
    renderButton({ readOnly: true });
    await openMenu();
    expect(screen.queryByTestId("ae-speak-fast")).toBeNull();
    expect(screen.getByTestId("ae-speak-replies")).not.toBeDisabled();
    expect(setEffort).not.toHaveBeenCalled();
  });

  it("shows the voice that will speak when none is chosen", async () => {
    renderButton();
    const user = await openMenu();
    expect(screen.getByTestId("ae-speak-voice-trigger")).toHaveTextContent("Aria (Natural)");
    await user.keyboard("{Escape}");
  });

  it("leaves the effort alone when Fast answers is off", async () => {
    window.localStorage.setItem("omnigent:ae-speak-fast-enabled", "false");
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-toggle"));
    expect(setEffort).not.toHaveBeenCalled();
  });

  it("hides Fast answers when the effort cannot be set", async () => {
    renderButton({ canSetEffort: false });
    const user = await openMenu();
    expect(screen.queryByTestId("ae-speak-fast")).toBeNull();
    await user.click(screen.getByTestId("ae-speak-toggle"));
    expect(setEffort).not.toHaveBeenCalled();
  });

  it("lists This device voices only when the server has no cloud voices", async () => {
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-voice-trigger"));
    const options = await screen.findAllByTestId("ae-speak-voice-option");
    expect(options[0]).toHaveTextContent("Aria (Natural)");
    expect(screen.getByText("This device")).toBeInTheDocument();
    expect(screen.queryByText("Natural (cloud)")).toBeNull();
    expect(screen.queryByText(/best here/)).toBeNull();
    options[0].focus();
    await user.keyboard("{Enter}");
    expect(window.localStorage.getItem("omnigent:ae-speak-voice")).toBe("device:aria");
  });

  it("lists cloud voices first, defaults to the first and stores a pick", async () => {
    serveCloudVoices(CLOUD);
    renderButton();
    const user = await openMenu();
    await waitFor(() =>
      expect(screen.getByTestId("ae-speak-voice-trigger")).toHaveTextContent("Ava"),
    );
    await user.click(screen.getByTestId("ae-speak-voice-trigger"));
    expect(await screen.findByText("Natural (cloud)")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
    const options = await screen.findAllByTestId("ae-speak-voice-option");
    expect(options[0]).toHaveTextContent("Ava");
    expect(options[1]).toHaveTextContent("Andrew");
    options[1].focus();
    await user.keyboard("{Enter}");
    expect(window.localStorage.getItem("omnigent:ae-speak-voice")).toBe(
      "cloud:en-US-AndrewMultilingualNeural",
    );
  });

  it("treats a bare stored value as no choice once the server has cloud voices", async () => {
    window.localStorage.setItem("omnigent:ae-speak-voice", "Plain");
    serveCloudVoices(CLOUD);
    renderButton();
    await openMenu();
    await waitFor(() =>
      expect(screen.getByTestId("ae-speak-voice-trigger")).toHaveTextContent("Ava"),
    );
  });

  it("keeps an explicit device choice when the server has cloud voices", async () => {
    window.localStorage.setItem("omnigent:ae-speak-voice", "device:Plain");
    serveCloudVoices(CLOUD);
    renderButton();
    await openMenu();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("ae-speak-voice-trigger")).toHaveTextContent("Plain"),
    );
  });

  it("adds the cloud voices to an open Voice sub-menu when the list arrives late", async () => {
    resetCloudVoicesCache();
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-voice-trigger"));
    expect(screen.queryByText("Natural (cloud)")).toBeNull();
    answer(new Response(JSON.stringify({ voices: CLOUD }), { status: 200 }));
    expect(await screen.findByText("Natural (cloud)")).toBeInTheDocument();
    expect(screen.getAllByTestId("ae-speak-voice-option")[0]).toHaveTextContent("Ava");
  });

  it("reads a bare stored value from before as a device voice", async () => {
    window.localStorage.setItem("omnigent:ae-speak-voice", "Plain");
    renderButton();
    await openMenu();
    expect(screen.getByTestId("ae-speak-voice-trigger")).toHaveTextContent("Plain");
  });

  it("shows Speed as a sub-menu with Normal and Faster", async () => {
    renderButton();
    const user = await openMenu();
    expect(screen.getByTestId("ae-speak-rate-trigger")).toHaveTextContent("Normal");
    await user.click(screen.getByTestId("ae-speak-rate-trigger"));
    expect(await screen.findByTestId("ae-speak-rate-normal")).toHaveTextContent("Normal");
    const faster = screen.getByTestId("ae-speak-rate-faster");
    expect(faster).toHaveTextContent("Faster");
    expect(faster).toHaveTextContent("1.25x");
  });

  it("stores the faster speed", async () => {
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-rate-trigger"));
    (await screen.findByTestId("ae-speak-rate-faster")).focus();
    await user.keyboard("{Enter}");
    expect(window.localStorage.getItem("omnigent:ae-speak-rate")).toBe("1.25");
  });

  it("offers Fastest 1.5x below Faster and stores it", async () => {
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-rate-trigger"));
    const fastest = await screen.findByTestId("ae-speak-rate-fastest");
    expect(fastest).toHaveTextContent("Fastest");
    expect(fastest).toHaveTextContent("1.5x");
    expect(
      screen.getByTestId("ae-speak-rate-faster").compareDocumentPosition(fastest) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fastest.focus();
    await user.keyboard("{Enter}");
    expect(window.localStorage.getItem("omnigent:ae-speak-rate")).toBe("1.5");
  });

  it("shows a stored 1.5 as Fastest and reads an unknown stored speed as Normal", async () => {
    window.localStorage.setItem("omnigent:ae-speak-rate", "1.5");
    const { unmount } = renderButton();
    await openMenu();
    expect(screen.getByTestId("ae-speak-rate-trigger")).toHaveTextContent("Fastest");
    unmount();
    window.localStorage.setItem("omnigent:ae-speak-rate", "2");
    renderButton();
    await openMenu();
    expect(screen.getByTestId("ae-speak-rate-trigger")).toHaveTextContent("Normal");
  });

  describe("Voice chat voice", () => {
    const BOTH = [
      { id: "rocky-xtts", name: "Rocky", provider: "rocky" },
      { id: "en-US-AvaMultilingualNeural", name: "Ava", provider: "azure" },
    ];
    const lastReply = () =>
      useChatStore.setState({
        blocks: [
          {
            type: "text_done",
            ctx: { agent: null, depth: 0, turn: 1, timestamp: 1, responseId: "r1", itemId: "i1" },
            fullText: "The last reply.",
            hasCodeBlocks: false,
          },
        ],
      } as never);
    function spyTts() {
      const calls: string[] = [];
      resetCloudVoicesCache();
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          if (String(url).includes("/tts/voices")) {
            return Promise.resolve(new Response(JSON.stringify({ voices: BOTH }), { status: 200 }));
          }
          if (String(url).includes("/v1/ae/tts")) calls.push(JSON.parse(String(init?.body)).voice);
          // A failed sentence falls to the device voice; nothing stays in flight for later tests.
          return Promise.resolve(new Response("no", { status: 500 }));
        }),
      );
      return calls;
    }

    it("is listed with a hint, Same as Speak replies and every voice", async () => {
      spyTts();
      renderButton();
      const user = await openMenu();
      expect(screen.getByTestId("ae-hint-voice.chat_voice")).toBeInTheDocument();
      expect(AE_SETTING_HINTS["voice.chat_voice"].hint).toMatch(/Rocky/);
      expect(AE_SETTING_HINTS["voice.chat_voice"].hint.length).toBeLessThanOrEqual(140);
      await waitFor(() =>
        expect(screen.getByTestId("ae-voice-chat-voice-trigger")).toHaveTextContent("Ava"),
      );
      await user.click(screen.getByTestId("ae-voice-chat-voice-trigger"));
      expect(await screen.findByTestId("ae-voice-chat-voice-same")).toHaveTextContent(
        "Same as Speak replies",
      );
      const names = screen.getAllByTestId("ae-voice-chat-voice-option").map((o) => o.textContent);
      expect(names).toEqual(expect.arrayContaining(["Rocky", "Ava", "Aria (Natural)"]));
    });

    it("saves the pick on this device", async () => {
      spyTts();
      renderButton();
      const user = await openMenu();
      await user.click(screen.getByTestId("ae-voice-chat-voice-trigger"));
      (await screen.findByTestId("ae-voice-chat-voice-same")).focus();
      await user.keyboard("{Enter}");
      expect(window.localStorage.getItem("omnigent:ae-voice-chat-voice")).toBe("same");
    });

    it("Read last reply uses it only while Voice mode is on", async () => {
      const calls = spyTts();
      window.localStorage.setItem("omnigent:ae-speak-voice", "cloud:rocky-xtts");
      lastReply();
      renderButton();
      const user = await openMenu();
      await screen.findByText("Rocky");
      await user.click(screen.getByTestId("ae-speak-read-last"));
      await waitFor(() => expect(calls).toEqual(["rocky-xtts"]));
      act(() => setVoiceOn("c1", true));
      const user2 = await openMenu();
      await user2.click(screen.getByTestId("ae-speak-read-last"));
      await waitFor(() => expect(calls).toEqual(["rocky-xtts", "en-US-AvaMultilingualNeural"]));
    });

    it("Same as Speak replies keeps the Speak voice in Voice mode", async () => {
      const calls = spyTts();
      window.localStorage.setItem("omnigent:ae-speak-voice", "cloud:rocky-xtts");
      window.localStorage.setItem("omnigent:ae-voice-chat-voice", "same");
      lastReply();
      renderButton();
      const user = await openMenu();
      await screen.findByText("Rocky");
      act(() => setVoiceOn("c1", true));
      await user.click(screen.getByTestId("ae-speak-read-last"));
      await waitFor(() => expect(calls).toEqual(["rocky-xtts"]));
    });
  });

  describe("Microphone and Speaker rows", () => {
    const setSinkId = vi.fn();
    const mediaDevices = (list: Partial<MediaDeviceInfo>[]) =>
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          enumerateDevices: () => Promise.resolve(list),
          addEventListener: () => {},
        },
      });
    const LIST: Partial<MediaDeviceInfo>[] = [
      { kind: "audioinput", deviceId: "mic1", label: "USB Mic" },
      { kind: "audiooutput", deviceId: "spk1", label: "Desk Speaker" },
    ];
    afterEach(() => {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    });

    it("gives the menu caret a real 44 px box on coarse pointers", async () => {
      renderButton();
      const trigger = screen.getByTestId("ae-speak-replies-menu");
      for (const cls of ["pointer-coarse:h-11", "pointer-coarse:w-9", "pointer-coarse:ml-0"]) {
        expect(trigger.className).toContain(cls);
      }
      expect(trigger.className).not.toContain("before:");
    });

    it("renders both rows under Speed and saves a pick", async () => {
      mediaDevices(LIST);
      (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId = setSinkId;
      renderButton();
      const user = await openMenu();
      expect(screen.getByTestId("ae-speak-mic-trigger")).toHaveTextContent("Default");
      expect(screen.getByTestId("ae-speak-speaker-trigger")).toHaveTextContent("Default");
      await user.click(screen.getByTestId("ae-speak-mic-trigger"));
      const options = await screen.findAllByTestId("ae-speak-mic-option");
      expect(options.map((o) => o.textContent)).toEqual(["System default", "USB Mic"]);
      options[1].focus();
      await user.keyboard("{Enter}");
      expect(window.localStorage.getItem("omnigent:ae-mic-device")).toBe("mic1");
    });

    it("shows the device model on the row and the full label in the title and sub-menu", async () => {
      mediaDevices([
        {
          kind: "audioinput",
          deviceId: "mic1",
          label: "Microphone (Logitech BRIO 4K Stream Edition)",
        },
      ]);
      window.localStorage.setItem("omnigent:ae-mic-device", "mic1");
      renderButton();
      const user = await openMenu();
      const value = await waitFor(() => {
        const el = screen.getByTestId("ae-speak-mic-trigger").querySelector("[title]");
        expect(el).toHaveTextContent("Logitech BRIO 4K Stream Edition");
        return el as HTMLElement;
      });
      expect(value).toHaveAttribute("title", "Microphone (Logitech BRIO 4K Stream Edition)");
      await user.click(screen.getByTestId("ae-speak-mic-trigger"));
      const options = await screen.findAllByTestId("ae-speak-mic-option");
      expect(options[1]).toHaveTextContent("Microphone (Logitech BRIO 4K Stream Edition)");
    });

    it("saves a speaker pick", async () => {
      mediaDevices(LIST);
      (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId = setSinkId;
      renderButton();
      const user = await openMenu();
      await user.click(screen.getByTestId("ae-speak-speaker-trigger"));
      const options = await screen.findAllByTestId("ae-speak-speaker-option");
      options[1].focus();
      await user.keyboard("{Enter}");
      expect(window.localStorage.getItem("omnigent:ae-speaker-device")).toBe("spk1");
    });

    it("hides both rows without enumerateDevices, and Speaker without setSinkId", async () => {
      renderButton();
      await openMenu();
      expect(screen.queryByTestId("ae-speak-mic-trigger")).toBeNull();
      expect(screen.queryByTestId("ae-speak-speaker-trigger")).toBeNull();
    });

    it("hides Speaker alone when setSinkId is missing", async () => {
      mediaDevices(LIST);
      renderButton();
      await openMenu();
      expect(screen.getByTestId("ae-speak-mic-trigger")).toBeInTheDocument();
      expect(screen.queryByTestId("ae-speak-speaker-trigger")).toBeNull();
    });

    it("shows a gone saved device as System default", async () => {
      window.localStorage.setItem("omnigent:ae-mic-device", "gone");
      mediaDevices(LIST);
      renderButton();
      await openMenu();
      expect(screen.getByTestId("ae-speak-mic-trigger")).toHaveTextContent("Default");
    });
  });

  it("puts the hint beside the label on every row and the actions side by side", async () => {
    mediaDevicesForLayout();
    renderButton();
    await openMenu();
    const triggers = document.querySelectorAll("[data-slot=tooltip-trigger]");
    expect(triggers).toHaveLength(11);
    for (const el of triggers) {
      const group = el.closest("span.items-center.gap-1\\.5");
      expect(group).not.toBeNull();
      expect(group?.textContent).toMatch(
        /Voice mode|Speak replies|Fast answers|Send snips|Mic while speaking|Voice|Speed|Microphone|Speaker|Add voice log/,
      );
    }
    const actions = screen.getByTestId("ae-speak-actions");
    expect(within(actions).getByTestId("ae-speak-read-last")).toBeInTheDocument();
    expect(within(actions).getByTestId("ae-speak-stop")).toHaveAttribute("data-disabled");
  });

  it("Add voice log to message asks the page to insert the log", async () => {
    renderButton();
    const user = await openMenu();
    const seen: string[] = [];
    const onInsert = (e: Event) => seen.push((e as CustomEvent<{ text: string }>).detail.text);
    window.addEventListener("ae-voice-log-insert", onInsert);
    await user.click(screen.getByTestId("ae-voice-log"));
    window.removeEventListener("ae-voice-log-insert", onInsert);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^Voice log /);
  });

  it("Read last reply speaks the last reply and Stop speaking cancels it", async () => {
    const synth = installFakeSpeech();
    synth.voices = [makeVoice({ name: "Plain", lang: "en-US", default: true })];
    useChatStore.setState({
      blocks: [
        {
          type: "text_done",
          ctx: { agent: null, depth: 0, turn: 1, timestamp: 1, responseId: "r1", itemId: "i1" },
          fullText: "The last reply.",
          hasCodeBlocks: false,
        },
      ],
    } as never);
    renderButton();
    const user = await openMenu();
    expect(screen.getByTestId("ae-speak-stop")).toHaveAttribute("data-disabled");
    await user.click(screen.getByTestId("ae-speak-read-last"));
    await waitFor(() => expect(synth.texts()).toEqual(["The last reply."]));
    const user2 = await openMenu();
    await waitFor(() =>
      expect(screen.getByTestId("ae-speak-stop")).not.toHaveAttribute("data-disabled"),
    );
    const cancels = synth.cancelCount;
    await user2.click(screen.getByTestId("ae-speak-stop"));
    expect(synth.cancelCount).toBeGreaterThan(cancels);
  });

  it("Read last reply uses the picked cloud voice and the picked speed", async () => {
    const calls: { url: string; body: string }[] = [];
    resetCloudVoicesCache();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (String(url).includes("/tts/voices")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ voices: [...CLOUD, { id: "rocky-xtts", name: "Rocky" }] }),
              {
                status: 200,
              },
            ),
          );
        }
        calls.push({ url: String(url), body: String(init?.body) });
        return new Promise<Response>(() => {});
      }),
    );
    window.localStorage.setItem("omnigent:ae-speak-voice", "cloud:rocky-xtts");
    window.localStorage.setItem("omnigent:ae-speak-rate", "1.25");
    useChatStore.setState({
      blocks: [
        {
          type: "text_done",
          ctx: { agent: null, depth: 0, turn: 1, timestamp: 1, responseId: "r1", itemId: "i1" },
          fullText: "The last reply.",
          hasCodeBlocks: false,
        },
      ],
    } as never);
    renderButton();
    const user = await openMenu();
    expect(await screen.findByText("Rocky")).toBeInTheDocument();
    await user.click(screen.getByTestId("ae-speak-read-last"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0].body)).toEqual({
      text: "The last reply.",
      voice: "rocky-xtts",
      rate: 1.25,
    });
  });

  it("keeps a stored cloud voice while the voice list is empty", async () => {
    const calls: string[] = [];
    resetCloudVoicesCache();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (String(url).includes("/tts/voices")) {
          return Promise.resolve(new Response(JSON.stringify({ voices: [] }), { status: 200 }));
        }
        calls.push(String(init?.body));
        return new Promise<Response>(() => {});
      }),
    );
    window.localStorage.setItem("omnigent:ae-speak-voice", "cloud:rocky-xtts");
    useChatStore.setState({
      blocks: [
        {
          type: "text_done",
          ctx: { agent: null, depth: 0, turn: 1, timestamp: 1, responseId: "r1", itemId: "i1" },
          fullText: "The last reply.",
          hasCodeBlocks: false,
        },
      ],
    } as never);
    const synth = installFakeSpeech();
    synth.voices = [makeVoice({ name: "Plain", lang: "en-US", default: true })];
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-read-last"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0]).voice).toBe("rocky-xtts");
    expect(synth.texts()).toEqual([]);
  });

  describe("Fast model", () => {
    const MODELS = [
      { id: "opus", model: "claude-opus-5-5" },
      { id: "claude-sonnet-5", model: "claude-sonnet-5" },
      { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5" },
    ];
    const setModel = vi.fn((_m: string | null, _o?: unknown) => Promise.resolve());
    const originalSetModel = useChatStore.getState().setModel;

    function renderModelButton(
      extra: Partial<React.ComponentProps<typeof AeSpeakRepliesButton>> = {},
    ) {
      return renderButton({
        modelOptions: MODELS,
        canSetModel: true,
        canResetModel: true,
        ...extra,
      });
    }
    function voiceOn(on: boolean) {
      act(() => setVoiceOn("c1", on));
    }
    // A mock that, like the store, records the override it was given.
    function followStore() {
      setModel.mockImplementation((m: string | null) => {
        useChatStore.setState({ sessionModelOverride: m } as never);
        return Promise.resolve();
      });
    }

    beforeEach(() => {
      setModel.mockReset();
      setModel.mockImplementation(() => Promise.resolve());
      useChatStore.setState({
        setModel,
        sessionModelOverride: "opus",
        llmModel: "claude-opus-5-5",
      } as never);
    });
    afterEach(() => {
      useChatStore.setState({
        setModel: originalSetModel,
        sessionModelOverride: null,
        llmModel: null,
      } as never);
    });

    it.each([
      ["a viewer", { readOnly: true }],
      ["a non-Claude chat", { canSetModel: false }],
      ["a chat without model rows", { modelOptions: [] }],
    ])("has no row for %s", async (_name, extra) => {
      renderModelButton(extra);
      await openMenu();
      expect(screen.queryByTestId("ae-voice-model-trigger")).toBeNull();
    });

    it("shows the row with its hint, the newest Sonnet as the default", async () => {
      renderModelButton();
      await openMenu();
      const row = screen.getByTestId("ae-voice-model-trigger");
      expect(within(row).getByText("Sonnet 5.5")).toBeInTheDocument();
      expect(screen.getByTestId("ae-hint-voice.fast_model")).toBeInTheDocument();
    });

    it("switches to the fast model when Voice mode starts and back when it ends", async () => {
      followStore();
      renderModelButton();
      voiceOn(true);
      await waitFor(() =>
        expect(setModel).toHaveBeenCalledWith("claude-sonnet-5-5", { expectConfirmation: true }),
      );
      expect(
        JSON.parse(window.localStorage.getItem("omnigent:ae-voice-model-state:c1") ?? "null"),
      ).toMatchObject({
        previous: "opus",
        fast: "claude-sonnet-5-5",
      });
      voiceOn(false);
      await waitFor(() =>
        expect(setModel).toHaveBeenLastCalledWith("opus", { expectConfirmation: true }),
      );
      await waitFor(() =>
        expect(window.localStorage.getItem("omnigent:ae-voice-model-state:c1")).toBeNull(),
      );
      expect(setModel).toHaveBeenCalledTimes(2);
    });

    it("sends a chat that followed the default back to the default", async () => {
      followStore();
      useChatStore.setState({ sessionModelOverride: null, llmModel: "claude-opus-5-5" } as never);
      renderModelButton();
      voiceOn(true);
      await waitFor(() =>
        expect(setModel).toHaveBeenCalledWith("claude-sonnet-5-5", expect.anything()),
      );
      voiceOn(false);
      await waitFor(() => expect(setModel).toHaveBeenLastCalledWith(null, expect.anything()));
    });

    it("restores the reported model when the session cannot reset to its default", async () => {
      followStore();
      useChatStore.setState({ sessionModelOverride: null, llmModel: "claude-opus-5-5" } as never);
      renderModelButton({ canResetModel: false });
      voiceOn(true);
      await waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
      voiceOn(false);
      await waitFor(() => expect(setModel).toHaveBeenLastCalledWith("opus", expect.anything()));
    });

    it("leaves a model the person picked by hand during Voice mode", async () => {
      followStore();
      renderModelButton();
      voiceOn(true);
      await waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
      act(() => useChatStore.setState({ sessionModelOverride: "claude-sonnet-5" } as never));
      voiceOn(false);
      await waitFor(() =>
        expect(window.localStorage.getItem("omnigent:ae-voice-model-state:c1")).toBeNull(),
      );
      expect(setModel).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the chat already runs the fast model", async () => {
      useChatStore.setState({ sessionModelOverride: "claude-sonnet-5-5" } as never);
      renderModelButton();
      voiceOn(true);
      await Promise.resolve();
      expect(setModel).not.toHaveBeenCalled();
      expect(window.localStorage.getItem("omnigent:ae-voice-model-state:c1")).toBeNull();
    });

    it("puts the model back after a reload that lost Voice mode", async () => {
      followStore();
      useChatStore.setState({ sessionModelOverride: "claude-sonnet-5-5" } as never);
      window.localStorage.setItem(
        "omnigent:ae-voice-model-state:c1",
        JSON.stringify({ previous: "opus", fallback: "opus", fast: "claude-sonnet-5-5" }),
      );
      renderModelButton();
      await waitFor(() =>
        expect(setModel).toHaveBeenCalledWith("opus", { expectConfirmation: true }),
      );
      await waitFor(() =>
        expect(window.localStorage.getItem("omnigent:ae-voice-model-state:c1")).toBeNull(),
      );
    });

    it("forgets the switch when it is refused", async () => {
      setModel.mockImplementation(() => Promise.reject(new Error("no")));
      renderModelButton();
      voiceOn(true);
      await waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(window.localStorage.getItem("omnigent:ae-voice-model-state:c1")).toBeNull(),
      );
    });

    const STATE_KEY = "omnigent:ae-voice-model-state:c1";
    function saveState(extra: Record<string, unknown> = {}) {
      window.localStorage.setItem(
        STATE_KEY,
        JSON.stringify({
          previous: "opus",
          fallback: "opus",
          fast: "claude-sonnet-5-5",
          owner: null,
          at: Date.now(),
          ...extra,
        }),
      );
    }

    it("retries a refused restore once the turn is idle, then shows a toast", async () => {
      const toastSpy = vi.spyOn(toast, "error").mockImplementation(() => "");
      followStore();
      renderModelButton();
      voiceOn(true);
      await waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
      setModel.mockImplementation(() => Promise.reject(new Error("no")));
      voiceOn(false);
      await waitFor(() => expect(setModel).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
      // The state stays so a later pass can still put the model back.
      expect(window.localStorage.getItem(STATE_KEY)).not.toBeNull();
      toastSpy.mockRestore();
    });

    it("clears the state when the retry of a refused restore succeeds", async () => {
      const toastSpy = vi.spyOn(toast, "error").mockImplementation(() => "");
      followStore();
      renderModelButton();
      voiceOn(true);
      await waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
      setModel.mockImplementationOnce(() => Promise.reject(new Error("no")));
      voiceOn(false);
      await waitFor(() => expect(setModel).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(window.localStorage.getItem(STATE_KEY)).toBeNull());
      expect(toastSpy).not.toHaveBeenCalled();
      toastSpy.mockRestore();
    });

    it("switches again when Voice mode comes back on during an in-flight restore", async () => {
      followStore();
      renderModelButton();
      voiceOn(true);
      await waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
      let release: () => void = () => {};
      setModel.mockImplementationOnce((m: string | null) => {
        return new Promise<void>((resolve) => {
          release = () => {
            useChatStore.setState({ sessionModelOverride: m } as never);
            resolve();
          };
        });
      });
      voiceOn(false);
      await waitFor(() => expect(setModel).toHaveBeenCalledTimes(2));
      voiceOn(true);
      await act(async () => release());
      await waitFor(() => expect(setModel).toHaveBeenCalledTimes(3));
      expect(setModel).toHaveBeenLastCalledWith("claude-sonnet-5-5", expect.anything());
    });

    it.each([
      ["no override yet", null],
      ["the previous model (a switch may be in flight)", "opus"],
      ["a model this chat does not list", "mystery"],
    ])("keeps the saved state after a reload while the override is %s", async (_n, override) => {
      useChatStore.setState({ sessionModelOverride: override } as never);
      saveState();
      renderModelButton();
      await Promise.resolve();
      await Promise.resolve();
      expect(setModel).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(STATE_KEY)).not.toBeNull();
    });

    it("forgets the saved state once a known third model is the override", async () => {
      useChatStore.setState({ sessionModelOverride: "claude-sonnet-5" } as never);
      saveState();
      renderModelButton();
      await waitFor(() => expect(window.localStorage.getItem(STATE_KEY)).toBeNull());
      expect(setModel).not.toHaveBeenCalled();
    });

    it("switches to a new Fast model pick while Voice mode runs and records it", async () => {
      followStore();
      renderModelButton();
      voiceOn(true);
      await waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
      const user = await openMenu();
      await user.click(screen.getByTestId("ae-voice-model-trigger"));
      const option = (await screen.findAllByTestId("ae-voice-model-option")).find(
        (el) => el.textContent === "Sonnet 5",
      ) as HTMLElement;
      option.focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(setModel).toHaveBeenLastCalledWith("claude-sonnet-5", { expectConfirmation: true }),
      );
      await waitFor(() =>
        expect(JSON.parse(window.localStorage.getItem(STATE_KEY) ?? "{}")).toMatchObject({
          fast: "claude-sonnet-5",
          previous: "opus",
        }),
      );
      voiceOn(false);
      await waitFor(() => expect(setModel).toHaveBeenLastCalledWith("opus", expect.anything()));
    });

    describe("another tab's switch", () => {
      beforeEach(() => {
        followStore();
        useChatStore.setState({ sessionModelOverride: "claude-sonnet-5-5" } as never);
        // This tab's Voice mode is off while the other tab keeps it on for the chat.
        getVoiceSnapshot("c1");
      });
      it("is left alone while its Voice mode is on and the state is fresh", async () => {
        window.localStorage.setItem("omnigent:ae-voice-mode:c1", "true");
        saveState({ owner: "some-other-tab" });
        renderModelButton();
        await Promise.resolve();
        await Promise.resolve();
        expect(setModel).not.toHaveBeenCalled();
        expect(window.localStorage.getItem(STATE_KEY)).not.toBeNull();
      });
      it("is put back when Voice mode is persisted off for the chat", async () => {
        saveState({ owner: "some-other-tab" });
        renderModelButton();
        await waitFor(() => expect(setModel).toHaveBeenCalledWith("opus", expect.anything()));
        await waitFor(() => expect(window.localStorage.getItem(STATE_KEY)).toBeNull());
      });
      it("is put back when the state is stale", async () => {
        window.localStorage.setItem("omnigent:ae-voice-mode:c1", "true");
        saveState({ owner: "some-other-tab", at: Date.now() - 7 * 3_600_000 });
        renderModelButton();
        await waitFor(() => expect(setModel).toHaveBeenCalledWith("opus", expect.anything()));
      });
    });

    it("skips setModel(null) and clears the state when there is nothing to restore", async () => {
      useChatStore.setState({ sessionModelOverride: "claude-sonnet-5-5" } as never);
      saveState({ previous: null, fallback: null });
      renderModelButton({ canResetModel: false });
      await waitFor(() => expect(window.localStorage.getItem(STATE_KEY)).toBeNull());
      expect(setModel).not.toHaveBeenCalled();
    });

    it("uses the model picked in the menu, and Off keeps the chat's model", async () => {
      followStore();
      renderModelButton();
      const user = await openMenu();
      await user.click(screen.getByTestId("ae-voice-model-trigger"));
      const option = (await screen.findAllByTestId("ae-voice-model-option")).find(
        (el) => el.textContent === "Sonnet 5",
      ) as HTMLElement;
      option.focus();
      await user.keyboard("{Enter}");
      expect(window.localStorage.getItem("omnigent:ae-voice-fast-model")).toBe("claude-sonnet-5");
      voiceOn(true);
      await waitFor(() =>
        expect(setModel).toHaveBeenCalledWith("claude-sonnet-5", expect.anything()),
      );
      voiceOn(false);
      await waitFor(() => expect(setModel).toHaveBeenLastCalledWith("opus", expect.anything()));
      const user2 = await openMenu();
      await user2.click(screen.getByTestId("ae-voice-model-trigger"));
      screen.getByTestId("ae-voice-model-off").focus();
      await user2.keyboard("{Enter}");
      expect(window.localStorage.getItem("omnigent:ae-voice-fast-model")).toBe("off");
      setModel.mockClear();
      voiceOn(true);
      await Promise.resolve();
      expect(setModel).not.toHaveBeenCalled();
    });
  });

  describe("device ids hidden before permission", () => {
    const HIDDEN: Partial<MediaDeviceInfo>[] = [
      { kind: "audioinput", deviceId: "", label: "" },
      { kind: "audiooutput", deviceId: "", label: "" },
    ];
    beforeEach(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { enumerateDevices: () => Promise.resolve(HIDDEN), addEventListener: () => {} },
      });
    });
    afterEach(() => {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    });

    it("shows System default, a muted line and no device radios", async () => {
      renderButton();
      const user = await openMenu();
      await user.click(screen.getByTestId("ae-speak-mic-trigger"));
      expect(await screen.findByText("Use the mic once to list devices.")).toBeInTheDocument();
      expect(screen.getAllByTestId("ae-speak-mic-option")).toHaveLength(1);
      expect(screen.getByTestId("ae-speak-mic-trigger")).toHaveTextContent("Default");
    });

    it("reads a saved microphone as Saved device", async () => {
      window.localStorage.setItem("omnigent:ae-mic-device", "mic1");
      renderButton();
      await openMenu();
      expect(screen.getByTestId("ae-speak-mic-trigger")).toHaveTextContent("Saved device");
    });

    it("ticks no radio for a saved device and clears it with System default", async () => {
      window.localStorage.setItem("omnigent:ae-mic-device", "mic1");
      renderButton();
      const user = await openMenu();
      await user.click(screen.getByTestId("ae-speak-mic-trigger"));
      const options = await screen.findAllByTestId("ae-speak-mic-option");
      expect(options[0]).toHaveAttribute("aria-checked", "false");
      options[0].focus();
      await user.keyboard("{Enter}");
      expect(window.localStorage.getItem("omnigent:ae-mic-device")).toBeNull();
      await openMenu();
      expect(await screen.findByTestId("ae-speak-mic-trigger")).toHaveTextContent("Default");
    });

    it("gives the value rows the shared shrink classes", async () => {
      renderButton();
      await openMenu();
      const value = screen.getByTestId("ae-speak-mic-trigger").querySelector("[title]");
      expect(value).toHaveClass("min-w-0", "flex-1", "truncate", "text-right");
      expect(value).not.toHaveClass("max-w-28");
    });
  });

  it("disables Stop speaking while idle", async () => {
    renderButton();
    await openMenu();
    expect(screen.getByTestId("ae-speak-stop")).toHaveAttribute("data-disabled");
  });

  it("skips the restore when the chat switched during the await", async () => {
    let release: () => void = () => {};
    setEffort.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderButton();
    const user = await openMenu();
    await user.click(screen.getByTestId("ae-speak-toggle"));
    await waitFor(() => expect(setEffort).toHaveBeenCalledWith("low"));
    await user.click(screen.getByTestId("ae-speak-toggle"));
    useChatStore.setState({ conversationId: "c2" } as never);
    release();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(setEffort).toHaveBeenCalledTimes(1);
  });
});

describe("Voice mode on the speaker button", () => {
  it("a tap turns Voice mode and Speak replies on, a second tap turns Voice mode off", async () => {
    renderButton();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ae-speak-replies"));
    expect(getVoiceSnapshot("c1").on).toBe(true);
    expect(screen.getByTestId("ae-speak-replies")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("ae-voice-phase")).toHaveTextContent("Starting the mic");
    const post = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).includes("/v1/ae/sessions/c1/voice"));
    expect(post).toBeDefined();
    await user.click(screen.getByTestId("ae-speak-replies"));
    expect(getVoiceSnapshot("c1").on).toBe(false);
    expect(screen.getByTestId("ae-voice-phase")).toBeEmptyDOMElement();
  });

  it("primes playback inside the tap that turns Voice mode on, not the one that turns it off", async () => {
    const synth = installFakeSpeech();
    renderButton();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ae-speak-replies"));
    expect(synth.spokenTexts).toEqual([" "]);
    expect((synth.spoken[0] as unknown as { volume: number }).volume).toBe(0);
    await user.click(screen.getByTestId("ae-speak-replies"));
    expect(synth.spokenTexts).toEqual([" "]);
  });

  it("registers its stop for the voice panel", async () => {
    const synth = installFakeSpeech();
    renderButton();
    const before = synth.cancelCount;
    act(() => stopVoice("c1"));
    expect(synth.cancelCount).toBeGreaterThan(before);
  });

  it("shows the phase only in the live region, not as a word beside the button", async () => {
    const { container } = renderButton();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ae-speak-replies"));
    act(() => setVoicePhase("c1", "listening"));
    expect(container.querySelector("span.sm\\:inline")).toBeNull();
    expect(screen.getByTestId("ae-voice-phase")).toHaveClass("sr-only");
  });

  it("reads a refused reply in the live region", async () => {
    renderButton();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ae-speak-replies"));
    act(() => setVoiceBlocked("c1", true));
    expect(screen.getByTestId("ae-voice-phase")).toHaveTextContent("Tap to hear the reply");
  });

  it("shows the phase word for each phase", async () => {
    renderButton();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ae-speak-replies"));
    act(() => setVoicePhase("c1", "thinking"));
    expect(screen.getByTestId("ae-voice-phase")).toHaveTextContent("Working on it");
    act(() => setVoicePhase("c1", "speaking"));
    expect(screen.getByTestId("ae-voice-phase")).toHaveTextContent("Speaking, tap to stop");
  });

  it("shows the words for the mic phases", async () => {
    renderButton();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ae-speak-replies"));
    for (const [phase, word] of [
      ["listening", "Listening"],
      ["paused", "Mic stopped"],
      ["unavailable", "Mic unavailable"],
    ] as const) {
      act(() => setVoicePhase("c1", phase));
      expect(screen.getByTestId("ae-voice-phase")).toHaveTextContent(word);
    }
  });

  it("a tap while speaking stops the reply, keeps Voice mode on and silences the rest of the turn", async () => {
    const synth = installFakeSpeech();
    renderButton();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ae-speak-replies"));
    act(() => getVoiceSnapshot("c1").speak?.("A sentence."));
    await waitFor(() => expect(getVoiceSnapshot("c1").speaking).toBe(true));
    const cancels = synth.cancelCount;
    await user.click(screen.getByTestId("ae-speak-replies"));
    expect(synth.cancelCount).toBeGreaterThan(cancels);
    expect(getVoiceSnapshot("c1")).toMatchObject({ on: true, barged: true });
  });

  it("the menu opens from the caret with the Voice mode row on top", async () => {
    renderButton();
    const user = await openMenu();
    const items = screen.getAllByRole("menuitemcheckbox");
    expect(items[0]).toHaveAttribute("data-testid", "ae-voice-mode-toggle");
    await user.click(screen.getByTestId("ae-voice-mode-toggle"));
    expect(getVoiceSnapshot("c1").on).toBe(true);
    expect(screen.getByTestId("ae-speak-toggle")).toHaveAttribute("aria-checked", "true");
  });

  it("turning Speak replies off turns Voice mode off too", async () => {
    renderButton();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ae-speak-replies"));
    await user.click(screen.getByTestId("ae-speak-replies-menu"));
    await user.click(screen.getByTestId("ae-speak-toggle"));
    expect(getVoiceSnapshot("c1").on).toBe(false);
    expect(screen.getByTestId("ae-speak-replies")).toHaveAttribute("aria-pressed", "false");
  });
});
