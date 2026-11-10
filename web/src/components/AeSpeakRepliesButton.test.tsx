import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCloudVoicesCache } from "@/lib/aeCloudVoice";
import { getVoiceSnapshot, resetVoiceStore, setVoicePhase } from "@/lib/aeVoiceMode";
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
      for (const cls of ["pointer-coarse:h-11", "pointer-coarse:w-11", "pointer-coarse:ml-0"]) {
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
        { kind: "audioinput", deviceId: "mic1", label: "Microphone (Logitech BRIO 4K Stream Edition)" },
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

  it("puts the hint beside the label on all eight rows and the actions side by side", async () => {
    mediaDevicesForLayout();
    renderButton();
    await openMenu();
    const triggers = document.querySelectorAll("[data-slot=tooltip-trigger]");
    expect(triggers).toHaveLength(8);
    for (const el of triggers) {
      const group = el.closest("span.items-center.gap-1\\.5");
      expect(group).not.toBeNull();
      expect(group?.textContent).toMatch(/Voice mode|Speak replies|Fast answers|Send snips|Voice|Speed|Microphone|Speaker/);
    }
    const actions = screen.getByTestId("ae-speak-actions");
    expect(within(actions).getByTestId("ae-speak-read-last")).toBeInTheDocument();
    expect(within(actions).getByTestId("ae-speak-stop")).toHaveAttribute("data-disabled");
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
    await waitFor(() => expect(screen.getByTestId("ae-speak-stop")).not.toHaveAttribute("data-disabled"));
    const cancels = synth.cancelCount;
    await user2.click(screen.getByTestId("ae-speak-stop"));
    expect(synth.cancelCount).toBeGreaterThan(cancels);
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
