"use client";

// Composer button and menu for Speak replies: the per-chat toggle, Fast answers,
// the voice and speed choices, Read last reply and Stop speaking.

import { RotateCcwIcon, SquareIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
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
import { type CloudVoice, fetchCloudVoices } from "@/lib/aeCloudVoice";
import {
  clearFastAnswersState,
  FAST_EFFORT,
  isSpeechSupported,
  listVoices,
  onVoicesChanged,
  pickDefaultVoice,
  RATE_FASTER,
  rankVoices,
  readFastAnswersState,
  readFastEnabled,
  readRate,
  readSpeakReplies,
  readVoiceChoice,
  type VoiceChoice,
  voiceLabel,
  writeFastAnswersState,
  writeFastEnabled,
  writeRate,
  writeSpeakReplies,
  writeVoiceChoice,
} from "@/lib/aeSpeakReplies";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";

const MAX_VOICES = 12;

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
function RowHint({ id }: { id: "voice.speak" | "voice.fast" | "voice.voice" | "voice.rate" }) {
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <span className="flex shrink-0" onPointerDown={stop} onPointerUp={stop} onClick={stop}>
      <AeHint id={id} />
    </span>
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
  hint: "voice.speak" | "voice.fast";
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
      <span className="flex-1">{label}</span>
      <Switch
        size="sm"
        checked={checked}
        tabIndex={-1}
        aria-label={label}
        className="pointer-events-none"
      />
      <RowHint id={hint} />
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
  const [stored, setStored] = useState(readVoiceChoice);
  const [cloudVoices, setCloudVoices] = useState<CloudVoice[]>([]);
  const [rate, setRate] = useState(readRate);
  const [voices, setVoices] = useState(listVoices);

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
  const voice: VoiceChoice | null =
    stored?.kind === "device"
      ? stored
      : stored && cloudVoices.some((v) => v.id === stored.id)
        ? stored
        : cloudVoices[0]
          ? { kind: "cloud", id: cloudVoices[0].id }
          : deviceDefault
            ? { kind: "device", id: deviceDefault.voiceURI }
            : null;

  const { speaking, stop, readLast } = useAeSpeakReplies({ chatId, enabled: on, voice, rate });

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
    }
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(className, on && "bg-muted/60 text-foreground")}
          aria-label="Speak replies"
          aria-pressed={on}
          title={`Speak replies: ${on ? "on" : "off"}`}
          data-testid="ae-speak-replies"
          disabled={disabled}
        >
          <Icon className={cn("size-4", on && speaking && "animate-pulse")} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-68 overflow-y-auto">
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
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="ae-speak-voice-trigger">
            <span>Voice</span>
            <span className="ml-auto truncate text-xs text-muted-foreground">{chosenName}</span>
            <RowHint id="voice.voice" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[60vh] overflow-y-auto">
            <DropdownMenuRadioGroup
              value={choiceKey(voice)}
              onValueChange={(key) => {
                const [kind, ...rest] = key.split(":");
                const next = { kind: kind as VoiceChoice["kind"], id: rest.join(":") };
                writeVoiceChoice(next);
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
            <span>Speed</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {rate === RATE_FASTER ? "Faster" : "Normal"}
            </span>
            <RowHint id="voice.rate" />
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
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={readLast} data-testid="ae-speak-read-last">
          <RotateCcwIcon className="size-4" />
          Read last reply
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!speaking} onSelect={stop} data-testid="ae-speak-stop">
          <SquareIcon className="size-4" />
          Stop speaking
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
