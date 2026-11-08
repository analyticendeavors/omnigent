// A fake window.speechSynthesis for jsdom, which has none.

export class FakeUtterance {
  voice: unknown = null;
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export interface FakeVoiceInit {
  name: string;
  lang: string;
  voiceURI?: string;
  default?: boolean;
}

export class FakeSynth {
  /** Set false to keep only texts and end callbacks, so the speaker alone holds utterances. */
  retain = true;
  spoken: FakeUtterance[] = [];
  spokenTexts: string[] = [];
  ends: (() => void)[] = [];
  cancelCount = 0;
  voices: SpeechSynthesisVoice[] = [];
  private listeners = new Set<() => void>();

  speak = (u: FakeUtterance) => {
    this.spokenTexts.push(u.text);
    if (u.onend) this.ends.push(u.onend);
    if (this.retain) this.spoken.push(u);
  };
  cancel = () => {
    this.cancelCount++;
  };
  getVoices = () => this.voices;
  addEventListener = (_type: string, cb: () => void) => {
    this.listeners.add(cb);
  };
  removeEventListener = (_type: string, cb: () => void) => {
    this.listeners.delete(cb);
  };
  emitVoicesChanged() {
    this.listeners.forEach((cb) => cb());
  }
  texts() {
    return this.spokenTexts;
  }
  /** Finish the oldest queued utterance, as the engine does. */
  finishNext() {
    this.spoken.find((u) => u.onend)?.onend?.();
  }
}

export function makeVoice(init: FakeVoiceInit): SpeechSynthesisVoice {
  return {
    name: init.name,
    lang: init.lang,
    voiceURI: init.voiceURI ?? init.name,
    default: init.default ?? false,
    localService: true,
  } as SpeechSynthesisVoice;
}

export function installFakeSpeech(): FakeSynth {
  const synth = new FakeSynth();
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    value: FakeUtterance,
    configurable: true,
  });
  return synth;
}

export function removeFakeSpeech(): void {
  delete (window as unknown as Record<string, unknown>).speechSynthesis;
  delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance;
}
