"use client";

// Composer button and menu for Speak replies: the per-chat toggle, Fast answers,
// the voice and speed choices, Read last reply and Stop speaking.

import { RotateCcwIcon, SquareIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAeSpeakReplies } from "@/hooks/useAeSpeakReplies";
import { AE_MENU_ROW_CLASS } from "@/lib/aeMenuRow";
import {
  clearFastAnswersState,
  FAST_EFFORT,
  isSpeechSupported,
  listVoices,
  onVoicesChanged,
  RATE_FASTER,
  rankVoices,
  readFastAnswersState,
  readFastEnabled,
  readRate,
  readSpeakReplies,
  readVoiceURI,
  voiceLabel,
  writeFastAnswersState,
  writeFastEnabled,
  writeRate,
  writeSpeakReplies,
  writeVoiceURI,
} from "@/lib/aeSpeakReplies";
import { aeHint } from "@/lib/aeSettingHints";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";

const MAX_VOICES = 12;
const HINT_CLASS = "block max-w-[20rem] text-xs font-normal text-muted-foreground";

export interface AeSpeakRepliesButtonProps {
  chatId: string | null;
  className?: string;
  disabled?: boolean;
  canSetEffort: boolean;
  currentEffort: string | null;
}

function Described({ label, hint }: { label: ReactNode; hint: string }) {
  return (
    <span className="flex flex-col">
      <span>{label}</span>
      <span className={HINT_CLASS}>{hint}</span>
    </span>
  );
}

function setChatEffort(level: string | null) {
  void useChatStore
    .getState()
    .setEffort(level)
    .catch(() => {});
}

export function AeSpeakRepliesButton(props: AeSpeakRepliesButtonProps) {
  if (!isSpeechSupported() || props.chatId === null) return null;
  return <SpeakRepliesControl {...props} chatId={props.chatId} />;
}

function SpeakRepliesControl({
  chatId,
  className,
  disabled,
  canSetEffort,
  currentEffort,
}: AeSpeakRepliesButtonProps & { chatId: string }) {
  const [on, setOn] = useState(() => readSpeakReplies(chatId));
  const [fastEnabled, setFastEnabled] = useState(readFastEnabled);
  const [voiceURI, setVoiceURI] = useState(readVoiceURI);
  const [rate, setRate] = useState(readRate);
  const [voices, setVoices] = useState(listVoices);

  useEffect(() => {
    setOn(readSpeakReplies(chatId));
  }, [chatId]);
  useEffect(() => {
    const refresh = () => setVoices(listVoices());
    refresh();
    return onVoicesChanged(refresh);
  }, []);

  const { speaking, stop, readLast } = useAeSpeakReplies({ chatId, enabled: on, voiceURI, rate });

  const applyFast = useCallback(() => {
    if (!canSetEffort || readFastAnswersState(chatId)) return;
    writeFastAnswersState(chatId, { previousEffort: currentEffort });
    setChatEffort(FAST_EFFORT);
  }, [canSetEffort, chatId, currentEffort]);

  const revertFast = useCallback(() => {
    const state = readFastAnswersState(chatId);
    if (!state) return;
    setChatEffort(state.previousEffort);
    clearFastAnswersState(chatId);
  }, [chatId]);

  const toggleSpeak = (next: boolean) => {
    writeSpeakReplies(chatId, next);
    setOn(next);
    if (next) {
      if (fastEnabled) applyFast();
    } else {
      stop();
      revertFast();
    }
  };

  const toggleFast = (next: boolean) => {
    writeFastEnabled(next);
    setFastEnabled(next);
    if (!on) return;
    if (next) applyFast();
    else revertFast();
  };

  const ranked = rankVoices(voices).slice(0, MAX_VOICES);
  const chosen = voices.find((v) => v.voiceURI === voiceURI);
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
      <DropdownMenuContent align="end" className="max-h-[70vh] overflow-y-auto">
        <DropdownMenuCheckboxItem
          checked={on}
          onCheckedChange={toggleSpeak}
          onSelect={(e) => e.preventDefault()}
          className={AE_MENU_ROW_CLASS}
          data-testid="ae-speak-toggle"
        >
          <Described label="Speak replies" hint={aeHint("voice.speak")} />
        </DropdownMenuCheckboxItem>
        {canSetEffort ? (
          <DropdownMenuCheckboxItem
            checked={fastEnabled}
            onCheckedChange={toggleFast}
            onSelect={(e) => e.preventDefault()}
            className={AE_MENU_ROW_CLASS}
            data-testid="ae-speak-fast"
          >
            <Described label="Fast answers" hint={aeHint("voice.fast")} />
          </DropdownMenuCheckboxItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="ae-speak-voice-trigger">
            <span className="flex flex-col">
              <span className="flex items-center justify-between gap-3">
                <span>Voice</span>
                <span className="text-xs text-muted-foreground">
                  {chosen ? voiceLabel(chosen) : "Default"}
                </span>
              </span>
              <span className={HINT_CLASS}>{aeHint("voice.voice")}</span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[60vh] overflow-y-auto">
            {ranked.length === 0 ? (
              <DropdownMenuItem disabled>No voices in this browser</DropdownMenuItem>
            ) : (
              <DropdownMenuRadioGroup
                value={voiceURI ?? ""}
                onValueChange={(uri) => {
                  writeVoiceURI(uri);
                  setVoiceURI(uri);
                }}
              >
                {ranked.map((voice, index) => (
                  <DropdownMenuRadioItem
                    key={voice.voiceURI}
                    value={voice.voiceURI}
                    data-testid="ae-speak-voice-option"
                  >
                    {voiceLabel(voice)}
                    {index === 0 ? (
                      <span className="ml-2 text-xs text-muted-foreground">best here</span>
                    ) : null}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <div className="px-2 py-1.5 text-sm">
          <Described label="Speed" hint={aeHint("voice.rate")} />
        </div>
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
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
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
