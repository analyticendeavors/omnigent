"use client";

// Menu rows shared by the speaker menu in a chat (AeSpeakRepliesButton) and the Voice menu
// on the new-chat page (AeVoiceStartButton): the row pieces, the per-device voice choices
// that need no chat, and Send voice log.

import { toast } from "sonner";
import { useEffect, useState } from "react";
import { AeHint } from "@/components/AeHint";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  micDevicesSupported,
  speakerSelectionSupported,
  shortDeviceName,
  useAudioDevices,
  useSavedAudioDevices,
  writeMicDevice,
  writeSpeakerDevice,
  type AudioDevice,
} from "@/lib/aeAudioDevices";
import { type CloudVoice, fetchCloudVoiceList } from "@/lib/aeCloudVoice";
import {
  isLegacyVoiceChoice,
  listVoices,
  onVoicesChanged,
  pickDefaultVoice,
  RATE_FASTER,
  RATE_FASTEST,
  rankVoices,
  readRate,
  readVoiceChoice,
  type VoiceChoice,
  voiceLabel,
  writeRate,
  writeVoiceChoice,
} from "@/lib/aeSpeakReplies";
import {
  readVoiceChatVoicePick,
  resolveVoiceChatVoice,
  VOICE_CHAT_VOICE_SAME,
  voiceChatVoiceKey,
  writeVoiceChatVoicePick,
} from "@/lib/aeVoiceChatVoice";
import { logVoice, uploadVoiceLog } from "@/lib/aeVoiceLog";
import { useMicWhileSpeaking, writeMicWhileSpeaking } from "@/lib/aeVoiceMic";

const MAX_VOICES = 12;
const VOICE_LIST_RETRIES = 3;
const VOICE_LIST_RETRY_MS = 2000;

export function choiceKey(choice: VoiceChoice | null): string {
  return choice ? `${choice.kind}:${choice.id}` : "";
}

/** The "i" sits inside a menu row: pressing it must not toggle or close the row. */
export function RowHint({
  id,
}: {
  id:
    | "voice.mode"
    | "voice.speak"
    | "voice.fast"
    | "voice.fast_model"
    | "voice.snips"
    | "voice.mic_while_speaking"
    | "voice.chat_voice"
    | "voice.voice"
    | "voice.rate"
    | "voice.microphone"
    | "voice.speaker"
    | "voice.log"
    | "voice.log_send"
    | "voice.start";
}) {
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <span className="flex shrink-0" onPointerDown={stop} onPointerUp={stop} onClick={stop}>
      <AeHint id={id} />
    </span>
  );
}

const SYSTEM_DEFAULT = "";

/** Value rows: the label group keeps its size, the value takes the rest and truncates. */
export const ROW_LABEL_CLASS = "flex shrink-0 items-center gap-1.5";
export const ROW_VALUE_CLASS =
  "min-w-0 flex-1 truncate pl-2 text-right text-xs text-muted-foreground";

/** A device row: current value on the row, radio items in the sub-menu. */
export function DeviceRow({
  label,
  hint,
  testId,
  devices,
  known,
  saved,
  onChoose,
}: {
  label: string;
  hint: "voice.microphone" | "voice.speaker";
  testId: string;
  devices: AudioDevice[];
  known: boolean;
  saved: string | null;
  onChoose: (id: string | null) => void;
}) {
  // A saved device that is gone reads as System default; the saved value stays for its return.
  const current = devices.find((d) => d.id === saved);
  // Before ids are known the saved id ticks no radio; System default clears it.
  const value = current ? current.id : !known && saved ? saved : SYSTEM_DEFAULT;
  // Before the browser shares device ids a saved choice cannot be named.
  const name = current ? current.label : !known && saved ? "Saved device" : "System default";
  // The row value is short so it fits the phone-width menu; the radio item keeps the full name.
  const rowValue = current ? shortDeviceName(name) : name === "System default" ? "Default" : name;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid={`${testId}-trigger`}>
        <span className={ROW_LABEL_CLASS}>
          {label}
          <RowHint id={hint} />
        </span>
        <span className={ROW_VALUE_CLASS} title={name}>
          {rowValue}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[60vh] overflow-y-auto">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => onChoose(v === SYSTEM_DEFAULT ? null : v)}
        >
          <DropdownMenuRadioItem value={SYSTEM_DEFAULT} data-testid={`${testId}-option`}>
            System default
          </DropdownMenuRadioItem>
          {!known ? (
            <div
              className="px-2 py-1.5 text-xs text-muted-foreground"
              data-testid={`${testId}-unknown`}
            >
              Use the mic once to list devices.
            </div>
          ) : null}
          {devices.map((d) => (
            <DropdownMenuRadioItem key={d.id} value={d.id} data-testid={`${testId}-option`}>
              {d.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function SwitchRow({
  label,
  checked,
  onChange,
  hint,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  hint:
    | "voice.mode"
    | "voice.speak"
    | "voice.fast"
    | "voice.snips"
    | "voice.mic_while_speaking"
    | "voice.start";
  testId: string;
}) {
  return (
    <DropdownMenuItem
      role="menuitemcheckbox"
      aria-checked={checked}
      onSelect={(e) => {
        e.preventDefault();
        onChange(!checked);
      }}
      data-testid={testId}
      className="min-h-8"
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {label}
        <RowHint id={hint} />
      </span>
      <Switch
        size="sm"
        checked={checked}
        tabIndex={-1}
        aria-label={label}
        className="pointer-events-none"
      />
    </DropdownMenuItem>
  );
}

/** The per-device voice choices and what they resolve to; none of it needs a chat. */
export function useVoiceChoices() {
  const [stored, setStored] = useState(readVoiceChoice);
  const [legacy, setLegacy] = useState(isLegacyVoiceChoice);
  const [cloudVoices, setCloudVoices] = useState<CloudVoice[]>([]);
  // True once the server answered, even with an empty list (an empty list is then real).
  const [cloudLoaded, setCloudLoaded] = useState(false);
  const [rate, setRate] = useState(readRate);
  const [voices, setVoices] = useState(listVoices);
  const [chatVoicePick, setChatVoicePick] = useState(readVoiceChatVoicePick);
  const savedDevices = useSavedAudioDevices();
  const audioDevices = useAudioDevices();

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const load = () => {
      void fetchCloudVoiceList().then((list) => {
        if (!live) return;
        if (list !== null) {
          setCloudLoaded(true);
          setCloudVoices(list);
          return;
        }
        // A failed fetch: retry a few times (a successful list is cached).
        attempts += 1;
        if (attempts <= VOICE_LIST_RETRIES)
          timer = setTimeout(load, VOICE_LIST_RETRY_MS * attempts);
      });
    };
    load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    const refresh = () => setVoices(listVoices());
    refresh();
    return onVoicesChanged(refresh);
  }, []);

  // A stored cloud voice the server no longer offers, or none stored: first cloud voice, else the device's.
  const deviceDefault = pickDefaultVoice(voices);
  // A bare value from before the prefixes is no choice once the server has cloud voices.
  // A stored cloud voice is never silently swapped for the device voice while the list is empty
  // (not loaded yet, or the fetch failed): the server knows the id, and the cloud speaker falls
  // back to the device per sentence if it cannot play.
  const voice: VoiceChoice | null =
    stored?.kind === "device" && !(legacy && cloudVoices.length > 0)
      ? { kind: "device", id: stored.id }
      : stored?.kind === "cloud" &&
          (cloudVoices.length === 0 || cloudVoices.some((v) => v.id === stored.id))
        ? { kind: "cloud", id: stored.id }
        : cloudVoices[0]
          ? { kind: "cloud", id: cloudVoices[0].id }
          : deviceDefault
            ? { kind: "device", id: deviceDefault.voiceURI }
            : null;
  const replacedCloud = stored?.kind === "cloud" && voice?.kind === "device";
  useEffect(() => {
    if (replacedCloud) logVoice("cloud voice replaced", `${choiceKey(stored)} -> device`);
  }, [replacedCloud, stored]);

  const chatVoice = resolveVoiceChatVoice(
    chatVoicePick,
    cloudLoaded ? cloudVoices : null,
    voice,
    deviceDefault ? { kind: "device", id: deviceDefault.voiceURI } : null,
    voices.map((v) => v.voiceURI),
  );
  return {
    stored,
    setStored,
    setLegacy,
    cloudVoices,
    rate,
    setRate,
    voices,
    chatVoicePick,
    setChatVoicePick,
    savedDevices,
    audioDevices,
    voice,
    chatVoice,
  };
}

export type VoiceChoices = ReturnType<typeof useVoiceChoices>;

/** Voice, Voice chat voice, Speed, Microphone and Speaker: per-device rows that need no chat. */
export function VoiceChoiceRows({ choices }: { choices: VoiceChoices }) {
  const {
    setStored,
    setLegacy,
    cloudVoices,
    rate,
    setRate,
    voices,
    chatVoicePick,
    setChatVoicePick,
    savedDevices,
    audioDevices,
    voice,
    chatVoice,
  } = choices;
  const ranked = rankVoices(voices).slice(0, MAX_VOICES);
  const chosenDevice =
    voice?.kind === "device" ? voices.find((v) => v.voiceURI === voice.id) : null;
  const chosenName =
    (voice?.kind === "cloud"
      ? cloudVoices.find((v) => v.id === voice.id)?.name
      : chosenDevice && voiceLabel(chosenDevice)) ?? "Default";
  const chatDevice =
    chatVoice?.kind === "device" ? voices.find((v) => v.voiceURI === chatVoice.id) : null;
  const chatVoiceName =
    chatVoicePick === VOICE_CHAT_VOICE_SAME
      ? "Same"
      : ((chatVoice?.kind === "cloud"
          ? cloudVoices.find((v) => v.id === chatVoice.id)?.name
          : chatDevice && voiceLabel(chatDevice)) ?? "Default");
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="ae-speak-voice-trigger">
          <span className={ROW_LABEL_CLASS}>
            Voice
            <RowHint id="voice.voice" />
          </span>
          <span className={ROW_VALUE_CLASS} title={chosenName}>
            {chosenName}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-[60vh] overflow-y-auto">
          <DropdownMenuRadioGroup
            value={choiceKey(voice)}
            onValueChange={(key) => {
              const [kind, ...rest] = key.split(":");
              const next = { kind: kind as VoiceChoice["kind"], id: rest.join(":") };
              writeVoiceChoice(next);
              setLegacy(false);
              setStored(next);
            }}
          >
            {cloudVoices.length > 0 ? (
              <>
                <DropdownMenuLabel>Natural (cloud)</DropdownMenuLabel>
                {cloudVoices.map((v) => (
                  <DropdownMenuRadioItem
                    key={v.id}
                    value={`cloud:${v.id}`}
                    data-testid="ae-speak-voice-option"
                  >
                    {v.name}
                  </DropdownMenuRadioItem>
                ))}
              </>
            ) : null}
            <DropdownMenuLabel>This device</DropdownMenuLabel>
            {ranked.length === 0 ? (
              <DropdownMenuItem disabled>No voices on this device</DropdownMenuItem>
            ) : (
              ranked.map((v) => (
                <DropdownMenuRadioItem
                  key={v.voiceURI}
                  value={`device:${v.voiceURI}`}
                  data-testid="ae-speak-voice-option"
                >
                  {voiceLabel(v)}
                </DropdownMenuRadioItem>
              ))
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="ae-voice-chat-voice-trigger">
          <span className={ROW_LABEL_CLASS}>
            Voice chat voice
            <RowHint id="voice.chat_voice" />
          </span>
          <span className={ROW_VALUE_CLASS} title={chatVoiceName}>
            {chatVoiceName}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-[60vh] overflow-y-auto">
          <DropdownMenuRadioGroup
            value={voiceChatVoiceKey(chatVoicePick, chatVoice)}
            onValueChange={(key) => {
              writeVoiceChatVoicePick(key);
              setChatVoicePick(key);
            }}
          >
            <DropdownMenuRadioItem
              value={VOICE_CHAT_VOICE_SAME}
              data-testid="ae-voice-chat-voice-same"
            >
              Same as Speak replies
            </DropdownMenuRadioItem>
            {cloudVoices.length > 0 ? (
              <>
                <DropdownMenuLabel>Natural (cloud)</DropdownMenuLabel>
                {cloudVoices.map((v) => (
                  <DropdownMenuRadioItem
                    key={v.id}
                    value={`cloud:${v.id}`}
                    data-testid="ae-voice-chat-voice-option"
                  >
                    {v.name}
                  </DropdownMenuRadioItem>
                ))}
              </>
            ) : null}
            <DropdownMenuLabel>This device</DropdownMenuLabel>
            {ranked.map((v) => (
              <DropdownMenuRadioItem
                key={v.voiceURI}
                value={`device:${v.voiceURI}`}
                data-testid="ae-voice-chat-voice-option"
              >
                {voiceLabel(v)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="ae-speak-rate-trigger">
          <span className={ROW_LABEL_CLASS}>
            Speed
            <RowHint id="voice.rate" />
          </span>
          <span className={ROW_VALUE_CLASS}>
            {rate === RATE_FASTEST ? "Fastest" : rate === RATE_FASTER ? "Faster" : "Normal"}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={String(rate)}
            onValueChange={(v) => {
              const next = Number(v);
              writeRate(next);
              setRate(next);
            }}
          >
            <DropdownMenuRadioItem value="1" data-testid="ae-speak-rate-normal">
              Normal
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value={String(RATE_FASTER)} data-testid="ae-speak-rate-faster">
              Faster
              <span className="ml-auto pl-3 text-xs text-muted-foreground">1.25x</span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value={String(RATE_FASTEST)} data-testid="ae-speak-rate-fastest">
              Fastest
              <span className="ml-auto pl-3 text-xs text-muted-foreground">1.5x</span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {micDevicesSupported() ? (
        <DeviceRow
          label="Microphone"
          hint="voice.microphone"
          testId="ae-speak-mic"
          devices={audioDevices.inputs}
          known={audioDevices.inputsKnown}
          saved={savedDevices.mic}
          onChoose={writeMicDevice}
        />
      ) : null}
      {speakerSelectionSupported() ? (
        <DeviceRow
          label="Speaker"
          hint="voice.speaker"
          testId="ae-speak-speaker"
          devices={audioDevices.outputs}
          known={audioDevices.outputsKnown}
          saved={savedDevices.speaker}
          onChoose={writeSpeakerDevice}
        />
      ) : null}
    </>
  );
}

/** Mic while speaking: a per-device switch. */
export function MicWhileSpeakingRow() {
  const micWhileSpeaking = useMicWhileSpeaking();
  return (
    <SwitchRow
      label="Mic while speaking"
      checked={micWhileSpeaking === "always"}
      onChange={(next) => writeMicWhileSpeaking(next ? "always" : "wait")}
      hint="voice.mic_while_speaking"
      testId="ae-voice-mic-while-speaking"
    />
  );
}

/** Sends the recent voice events to the server so a mic problem can be read afterwards. */
export function SendVoiceLogRow({ chatId }: { chatId?: string | null }) {
  return (
    <DropdownMenuItem
      onSelect={() => {
        void uploadVoiceLog("manual", chatId).then((result) => {
          if (result === "failed") toast.error("Could not send the voice log");
          else toast.success("Voice log sent");
        });
      }}
      data-testid="ae-voice-log-send"
    >
      <span className={ROW_LABEL_CLASS}>
        Send voice log
        <RowHint id="voice.log_send" />
      </span>
    </DropdownMenuItem>
  );
}
