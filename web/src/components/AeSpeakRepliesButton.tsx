"use client";

// Composer button and menu for Speak replies: the per-chat toggle, Fast answers,
// the voice and speed choices, Read last reply and Stop speaking.

import { ChevronDownIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AeHint } from "@/components/AeHint";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useAeSpeakReplies } from "@/hooks/useAeSpeakReplies";
import { logVoice, requestVoiceLogInsert } from "@/lib/aeVoiceLog";
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
import { type CloudVoice, fetchCloudVoices } from "@/lib/aeCloudVoice";
import {
  clearFastAnswersState,
  FAST_EFFORT,
  isSpeechSupported,
  listVoices,
  primeVoicePlayback,
  onVoicesChanged,
  pickDefaultVoice,
  RATE_FASTER,
  rankVoices,
  readFastAnswersState,
  readFastEnabled,
  readRate,
  readSpeakReplies,
  isLegacyVoiceChoice,
  readVoiceChoice,
  type VoiceChoice,
  voiceLabel,
  writeFastAnswersState,
  writeFastEnabled,
  writeRate,
  writeSpeakReplies,
  writeVoiceChoice,
} from "@/lib/aeSpeakReplies";
import {
  registerVoiceSpeaker,
  registerVoiceStop,
  setVoiceBarged,
  setVoiceOn,
  setVoiceSpeaking,
  useVoiceSnapshot,
  type VoicePhase,
} from "@/lib/aeVoiceMode";
import { useMicWhileSpeaking, writeMicWhileSpeaking } from "@/lib/aeVoiceMic";
import { useSendSnips, writeSendSnips } from "@/lib/aeVoiceSnips";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";

const MAX_VOICES = 12;

const PHASE_WORD: Record<VoicePhase, string> = {
  off: "",
  starting: "Starting the mic",
  listening: "Listening",
  paused: "Mic stopped",
  unavailable: "Mic unavailable",
  thinking: "Working on it",
  speaking: "Speaking, tap to stop",
};

export interface AeSpeakRepliesButtonProps {
  chatId: string | null;
  className?: string;
  disabled?: boolean;
  /** A viewer can still listen and stop, but cannot change the chat's effort. */
  readOnly?: boolean;
  canSetEffort: boolean;
  currentEffort: string | null;
}

function choiceKey(choice: VoiceChoice | null): string {
  return choice ? `${choice.kind}:${choice.id}` : "";
}

/** The "i" sits inside a menu row: pressing it must not toggle or close the row. */
function RowHint({
  id,
}: {
  id:
    | "voice.mode"
    | "voice.speak"
    | "voice.fast"
    | "voice.snips"
    | "voice.mic_while_speaking"
    | "voice.voice"
    | "voice.rate"
    | "voice.microphone"
    | "voice.speaker"
    | "voice.log";
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
const ROW_LABEL_CLASS = "flex shrink-0 items-center gap-1.5";
const ROW_VALUE_CLASS = "min-w-0 flex-1 truncate pl-2 text-right text-xs text-muted-foreground";

/** A device row: current value on the row, radio items in the sub-menu. */
function DeviceRow({
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
            <div className="px-2 py-1.5 text-xs text-muted-foreground" data-testid={`${testId}-unknown`}>
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

function SwitchRow({
  label,
  checked,
  onChange,
  hint,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  hint: "voice.mode" | "voice.speak" | "voice.fast" | "voice.snips" | "voice.mic_while_speaking";
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

function setChatEffort(level: string | null): Promise<void> {
  return useChatStore.getState().setEffort(level);
}

export function AeSpeakRepliesButton(props: AeSpeakRepliesButtonProps) {
  if (!isSpeechSupported() || props.chatId === null) return null;
  return <SpeakRepliesControl key={props.chatId} {...props} chatId={props.chatId} />;
}

function SpeakRepliesControl({
  chatId,
  className,
  disabled,
  readOnly,
  canSetEffort,
  currentEffort,
}: AeSpeakRepliesButtonProps & { chatId: string }) {
  const [on, setOn] = useState(() => readSpeakReplies(chatId));
  const [fastEnabled, setFastEnabled] = useState(readFastEnabled);
  const snips = useSendSnips();
  const micWhileSpeaking = useMicWhileSpeaking();
  const [stored, setStored] = useState(readVoiceChoice);
  const [legacy, setLegacy] = useState(isLegacyVoiceChoice);
  const [cloudVoices, setCloudVoices] = useState<CloudVoice[]>([]);
  const [rate, setRate] = useState(readRate);
  const [voices, setVoices] = useState(listVoices);
  const savedDevices = useSavedAudioDevices();
  const audioDevices = useAudioDevices();

  useEffect(() => {
    setOn(readSpeakReplies(chatId));
  }, [chatId]);
  useEffect(() => {
    let live = true;
    void fetchCloudVoices().then((list) => {
      if (live) setCloudVoices(list);
    });
    return () => {
      live = false;
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
  const voice: VoiceChoice | null =
    stored?.kind === "device" && !(legacy && cloudVoices.length > 0)
      ? { kind: "device", id: stored.id }
      : stored?.kind === "cloud" && cloudVoices.some((v) => v.id === stored.id)
        ? { kind: "cloud", id: stored.id }
        : cloudVoices[0]
          ? { kind: "cloud", id: cloudVoices[0].id }
          : deviceDefault
            ? { kind: "device", id: deviceDefault.voiceURI }
            : null;

  const { speaking, stop, readLast, speak } = useAeSpeakReplies({
    chatId,
    enabled: on,
    voice,
    rate,
  });
  const voiceMode = useVoiceSnapshot(chatId);
  useEffect(() => registerVoiceSpeaker(chatId, speak), [chatId, speak]);
  useEffect(() => registerVoiceStop(chatId, stop), [chatId, stop]);
  useEffect(() => setVoiceSpeaking(chatId, speaking), [chatId, speaking]);

  const fastAvailable = canSetEffort && !readOnly;
  const wanted = useRef({ on, fastEnabled });
  wanted.current = { on, fastEnabled };
  const effortRef = useRef(currentEffort);
  effortRef.current = currentEffort;
  const busyRef = useRef(false);
  const availableRef = useRef(fastAvailable);
  availableRef.current = fastAvailable;
  // The effort belongs to the chat on screen: never write it after the view moved on.
  const mayTouchEffort = useCallback(
    () => availableRef.current && useChatStore.getState().conversationId === chatId,
    [chatId],
  );

  const applyFast = useCallback(async () => {
    if (busyRef.current || readFastAnswersState(chatId)) return;
    const previousEffort = effortRef.current;
    busyRef.current = true;
    try {
      await setChatEffort(FAST_EFFORT);
    } catch {
      return;
    } finally {
      busyRef.current = false;
    }
    if (wanted.current.on && wanted.current.fastEnabled) {
      writeFastAnswersState(chatId, { previousEffort });
    } else {
      // Turned off while the change was in flight: put the effort back.
      if (mayTouchEffort()) await setChatEffort(previousEffort).catch(() => {});
    }
  }, [chatId, mayTouchEffort]);

  const revertFast = useCallback(async () => {
    const state = readFastAnswersState(chatId);
    if (!state || !mayTouchEffort()) return;
    // An effort the user changed by hand since stays as they left it.
    if (effortRef.current === FAST_EFFORT) {
      try {
        await setChatEffort(state.previousEffort);
      } catch {
        return;
      }
    }
    clearFastAnswersState(chatId);
  }, [chatId, mayTouchEffort]);

  // Effort levels can arrive after the toggle, so apply whenever it is wanted and not yet applied.
  useEffect(() => {
    if (on && fastEnabled && fastAvailable && currentEffort !== FAST_EFFORT) void applyFast();
  }, [on, fastEnabled, fastAvailable, currentEffort, applyFast]);

  const toggleSpeak = (next: boolean) => {
    writeSpeakReplies(chatId, next);
    setOn(next);
    if (!next) {
      stop();
      void revertFast();
      if (voiceMode.on) setVoiceOn(chatId, false);
    }
  };

  // Voice mode needs Speak replies, so turning it on turns that on too.
  const toggleVoice = (next: boolean) => {
    // Inside the tap: iOS refuses later playback unless a tap started audio.
    if (next) primeVoicePlayback();
    if (next && !on) toggleSpeak(true);
    setVoiceOn(chatId, next);
  };
  useEffect(() => {
    if (voiceMode.on && !on) toggleSpeak(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode.on]);
  const tapSpeaker = () => {
    if (voiceMode.on && speaking) {
      // A barge-in: stop now and stay quiet for the rest of this turn.
      logVoice("barge");
      setVoiceBarged(chatId, true);
      stop();
    } else toggleVoice(!voiceMode.on);
  };

  const toggleFast = (next: boolean) => {
    writeFastEnabled(next);
    setFastEnabled(next);
    if (!next && on) void revertFast();
  };

  const ranked = rankVoices(voices).slice(0, MAX_VOICES);
  const chosenDevice =
    voice?.kind === "device" ? voices.find((v) => v.voiceURI === voice.id) : null;
  const chosenName =
    (voice?.kind === "cloud"
      ? cloudVoices.find((v) => v.id === voice.id)?.name
      : chosenDevice && voiceLabel(chosenDevice)) ?? "Default";
  const Icon = on ? Volume2Icon : VolumeXIcon;

  const phaseWord =
    voiceMode.on && voiceMode.blocked ? "Tap to hear the reply" : PHASE_WORD[voiceMode.phase];
  return (
    <DropdownMenu>
      <span className="sr-only" aria-live="polite" data-testid="ae-voice-phase">
        {phaseWord}
      </span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={cn(
          className,
          on && "bg-muted/60 text-foreground",
          voiceMode.phase === "listening" && "animate-pulse text-teal-500 ring-2 ring-teal-500/60",
          voiceMode.phase === "thinking" && "text-amber-500 ring-2 ring-amber-500/60",
        )}
        aria-label="Speak replies"
        aria-pressed={on}
        title={`Speak replies: ${on ? "on" : "off"}${voiceMode.on ? ". Voice mode on" : ""}`}
        data-testid="ae-speak-replies"
        data-voice-phase={voiceMode.phase}
        disabled={disabled}
        onClick={tapSpeaker}
      >
        <Icon className={cn("size-4", on && speaking && "animate-pulse")} />
      </Button>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="-ml-1 h-7 w-4 text-muted-foreground pointer-coarse:ml-0 pointer-coarse:h-11 pointer-coarse:w-9"
          aria-label="Speak replies menu"
          data-testid="ae-speak-replies-menu"
          disabled={disabled}
        >
          <ChevronDownIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-61 overflow-y-auto">
        <SwitchRow
          label="Voice mode"
          checked={voiceMode.on}
          onChange={toggleVoice}
          hint="voice.mode"
          testId="ae-voice-mode-toggle"
        />
        <DropdownMenuSeparator />
        <SwitchRow
          label="Speak replies"
          checked={on}
          onChange={toggleSpeak}
          hint="voice.speak"
          testId="ae-speak-toggle"
        />
        {fastAvailable ? (
          <SwitchRow
            label="Fast answers"
            checked={fastEnabled}
            onChange={toggleFast}
            hint="voice.fast"
            testId="ae-speak-fast"
          />
        ) : null}
        <SwitchRow
          label="Send snips"
          checked={snips}
          onChange={writeSendSnips}
          hint="voice.snips"
          testId="ae-voice-snips"
        />
        <SwitchRow
          label="Mic while speaking"
          checked={micWhileSpeaking === "always"}
          onChange={(next) => writeMicWhileSpeaking(next ? "always" : "wait")}
          hint="voice.mic_while_speaking"
          testId="ae-voice-mic-while-speaking"
        />
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
          <DropdownMenuSubTrigger data-testid="ae-speak-rate-trigger">
            <span className={ROW_LABEL_CLASS}>
              Speed
              <RowHint id="voice.rate" />
            </span>
            <span className={ROW_VALUE_CLASS}>
              {rate === RATE_FASTER ? "Faster" : "Normal"}
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
        <DropdownMenuSeparator />
        <div className="flex gap-1.5 px-1 pb-1 pt-0.5" data-testid="ae-speak-actions">
          <DropdownMenuItem
            onSelect={readLast}
            data-testid="ae-speak-read-last"
            className="min-h-8 flex-1 justify-center rounded-md border border-border/60 text-[13px]"
          >
            Read last reply
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!speaking}
            onSelect={stop}
            data-testid="ae-speak-stop"
            className="min-h-8 flex-1 justify-center rounded-md border border-border/60 text-[13px]"
          >
            Stop speaking
          </DropdownMenuItem>
        </div>
        <DropdownMenuItem onSelect={requestVoiceLogInsert} data-testid="ae-voice-log">
          <span className={ROW_LABEL_CLASS}>
            Add voice log to message
            <RowHint id="voice.log" />
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
