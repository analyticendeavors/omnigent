import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAudioSessionState } from "@/lib/aeAudioSession";
import { resetVoiceLog } from "@/lib/aeVoiceLog";
import {
  armVoiceForNextChat,
  disarmVoiceForNextChat,
  resetVoiceStore,
  setVoiceOn,
  takeVoiceArm,
} from "@/lib/aeVoiceMode";
import { useChatStore } from "@/store/chatStore";
import { installFakeSpeech, removeFakeSpeech } from "@/test/fakeSpeech";
import { useAeVoiceMode } from "./useAeVoiceMode";

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";

const controller = {
  current: {
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isListening: () => false,
    startPath: () => "browser" as const,
  },
};
const submit = vi.fn();
const session = () => (navigator as unknown as { audioSession: { type: string } }).audioSession;

function mount(chatId: string) {
  return renderHook(() =>
    useAeVoiceMode({ controller, chatId, value: "", status: "idle", canSend: true, submit }),
  );
}

let originalUa: PropertyDescriptor | undefined;
beforeEach(() => {
  originalUa = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: IOS_UA });
  Object.defineProperty(navigator, "audioSession", {
    configurable: true,
    writable: true,
    value: { type: "auto" },
  });
  window.localStorage.clear();
  resetAudioSessionState();
  resetVoiceStore();
  resetVoiceLog();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))),
  );
  installFakeSpeech();
  useChatStore.setState({ conversationId: "c1", blocks: [], status: "idle" } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  removeFakeSpeech();
  delete (navigator as { audioSession?: unknown }).audioSession;
  if (originalUa) Object.defineProperty(navigator, "userAgent", originalUa);
  else delete (navigator as { userAgent?: unknown }).userAgent;
});

describe("useAeVoiceMode audio session", () => {
  it("new-chat path: arm, setVoiceOn, start page unmount keeps play-and-record while the new chat's Voice runs", () => {
    armVoiceForNextChat();
    // handleCreate reads the arm, the chat is created, Voice goes on, the landing unmounts.
    takeVoiceArm();
    setVoiceOn("new1", true);
    disarmVoiceForNextChat();
    expect(session().type).toBe("play-and-record");
    const chat = mount("new1");
    expect(session().type).toBe("play-and-record");
    session().type = "playback";
    chat.rerender();
    chat.unmount();
    expect(session().type).toBe("auto");
  });

  it("two mounted Voice chats: the first leaving does not restore", () => {
    setVoiceOn("a", true);
    setVoiceOn("b", true);
    const a = mount("a");
    const b = mount("b");
    expect(session().type).toBe("play-and-record");
    a.unmount();
    expect(session().type).toBe("play-and-record");
    b.unmount();
    expect(session().type).toBe("auto");
  });

  it("turning chat B off while chat A is still on does not restore", () => {
    setVoiceOn("a", true);
    setVoiceOn("b", true);
    mount("a");
    const b = mount("b");
    setVoiceOn("b", false);
    b.rerender();
    expect(session().type).toBe("play-and-record");
  });

  it("leaving a Voice-on chat (unmount) restores the type", () => {
    setVoiceOn("a", true);
    const a = mount("a");
    expect(session().type).toBe("play-and-record");
    a.unmount();
    expect(session().type).toBe("auto");
  });

  it("a chat with Voice off holds nothing", () => {
    const a = mount("off");
    expect(session().type).toBe("auto");
    a.unmount();
  });
});
