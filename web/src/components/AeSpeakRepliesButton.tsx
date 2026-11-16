"use client";

// Composer button and menu for Speak replies: the per-chat toggle, Fast answers,
// the voice and speed choices, Read last reply and Stop speaking.

import { ChevronDownIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
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
import {
  MicWhileSpeakingRow,
  RowHint,
  ROW_LABEL_CLASS,
  ROW_VALUE_CLASS,
  SendVoiceLogRow,
  SwitchRow,
  useVoiceChoices,
  VoiceChoiceRows,
} from "@/components/AeVoiceMenuRows";
import { logVoice, requestVoiceLogInsert } from "@/lib/aeVoiceLog";
import {
  clearVoiceModelState,
  effectiveModelId,
  mayRevertVoiceModel,
  readVoiceModelPick,
  readVoiceModelState,
  resolveFastModel,
  VOICE_MODEL_OFF,
  voiceModelLabel,
  voiceModelVerdict,
  writeVoiceModelPick,
  writeVoiceModelState,
} from "@/lib/aeVoiceModel";
import { findNativeModelOption } from "@/lib/codexNativeModels";
import type { NativeModelOption } from "@/lib/types";
import {
  clearFastAnswersState,
  FAST_EFFORT,
  isSpeechSupported,
  primeVoicePlayback,
  readFastAnswersState,
  readFastEnabled,
  readSpeakReplies,
  writeFastAnswersState,
  writeFastEnabled,
  writeSpeakReplies,
} from "@/lib/aeSpeakReplies";
import {
  registerVoiceSpeaker,
  readVoiceMode,
  registerVoiceStop,
  setVoiceBarged,
  setVoiceOn,
  setVoiceSpeaking,
  useVoiceSnapshot,
  type VoicePhase,
} from "@/lib/aeVoiceMode";
import { useSendSnips, writeSendSnips } from "@/lib/aeVoiceSnips";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chatStore";

const PHASE_WORD: Record<VoicePhase, string> = {
  off: "",
  starting: "Starting the mic",
  listening: "Listening",
  paused: "Mic stopped",
  unavailable: "Mic unavailable",
  thinking: "Working on it",
  speaking: "Speaking, tap to stop",
  approval: "Waiting for your OK",
  preparing: "Getting the chat ready",
  stalled: "Chat not ready",
};

export interface AeSpeakRepliesButtonProps {
  chatId: string | null;
  className?: string;
  disabled?: boolean;
  /** A viewer can still listen and stop, but cannot change the chat's effort. */
  readOnly?: boolean;
  canSetEffort: boolean;
  currentEffort: string | null;
  /** The chat's Claude model rows; the Fast model row needs a Claude chat with rows. */
  modelOptions?: readonly NativeModelOption[];
  /** False for a viewer, a non-Claude chat or a chat on cost routing. */
  canSetModel?: boolean;
  /** The session can go back to its default model (a null pick). */
  canResetModel?: boolean;
}

const NO_MODEL_OPTIONS: readonly NativeModelOption[] = [];

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
  modelOptions = NO_MODEL_OPTIONS,
  canSetModel = false,
  canResetModel = false,
}: AeSpeakRepliesButtonProps & { chatId: string }) {
  const [on, setOn] = useState(() => readSpeakReplies(chatId));
  const [fastEnabled, setFastEnabled] = useState(readFastEnabled);
  const snips = useSendSnips();
  const choices = useVoiceChoices();
  const { voice, chatVoice, rate } = choices;

  useEffect(() => {
    setOn(readSpeakReplies(chatId));
  }, [chatId]);
  // While Voice mode is on, the Voice chat voice speaks (replies, Read last reply, approval line).
  const voiceMode = useVoiceSnapshot(chatId);
  const { speaking, stop, readLast, speak } = useAeSpeakReplies({
    chatId,
    enabled: on,
    voice: voiceMode.on ? chatVoice : voice,
    voiceMode: voiceMode.on,
    rate,
  });
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

  // Fast model: Voice mode runs a Claude chat on a quick model and puts the old one back at the end.
  const [modelPick, setModelPick] = useState(readVoiceModelPick);
  const fastModel = resolveFastModel(modelPick, modelOptions);
  const modelAvailable = canSetModel && !readOnly && modelOptions.length > 0;
  const fastRow = modelOptions.find((o) => o.id === fastModel);
  const fastModelName = fastRow ? voiceModelLabel(fastRow) : "Off";
  const modelWanted = voiceMode.on && fastModel !== null && modelAvailable;
  const modelRefs = useRef({ wanted: modelWanted, fastModel, modelOptions, canResetModel });
  modelRefs.current = { wanted: modelWanted, fastModel, modelOptions, canResetModel };
  const modelAvailableRef = useRef(modelAvailable);
  modelAvailableRef.current = modelAvailable;
  const modelBusyRef = useRef(false);
  const mayTouchModel = useCallback(
    () => modelAvailableRef.current && useChatStore.getState().conversationId === chatId,
    [chatId],
  );

  // A refused restore is retried once when the turn goes idle (or on the next render that wants it).
  const revertFailures = useRef(0);
  const [revertRetry, setRevertRetry] = useState(false);
  const chatStatus = useChatStore((st) => st.status);
  const applyRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const revertModel = useCallback(async (): Promise<void> => {
    const state = readVoiceModelState(chatId);
    if (!state || modelBusyRef.current || !mayTouchModel()) return;
    // Another tab's live switch is not this tab's to put back.
    if (!mayRevertVoiceModel(state, readVoiceMode(chatId))) return;
    const store = useChatStore.getState();
    const verdict = voiceModelVerdict(
      state,
      store.sessionModelOverride,
      modelRefs.current.modelOptions,
    );
    // Not hydrated yet, or a switch may still be in flight: keep the state for a later pass.
    if (verdict === "keep") return;
    // A model picked by hand since Voice mode switched stays as the person left it.
    if (verdict === "revert") {
      const canReset = modelRefs.current.canResetModel;
      const target = state.previous ?? (canReset ? null : state.fallback);
      if (target === null && state.previous === null && !canReset) {
        // Nothing to restore and no way to reset: setModel(null) would be refused.
        logVoice("model restore skipped", "no previous model and no reset");
        clearVoiceModelState(chatId);
        return;
      }
      modelBusyRef.current = true;
      try {
        await store.setModel(target, { expectConfirmation: true });
      } catch {
        revertFailures.current += 1;
        logVoice("model restore failed", `attempt ${revertFailures.current}`);
        if (revertFailures.current === 1) setRevertRetry(true);
        else {
          setRevertRetry(false);
          toast.error("Could not switch the model back. Pick it in the model menu.");
        }
        return;
      } finally {
        modelBusyRef.current = false;
      }
    }
    revertFailures.current = 0;
    setRevertRetry(false);
    clearVoiceModelState(chatId);
    // Voice mode came back on while the restore was in flight: switch again.
    if (modelRefs.current.wanted) void applyRef.current();
  }, [chatId, mayTouchModel]);

  const applyModel = useCallback(async () => {
    const { fastModel: fast, modelOptions: options } = modelRefs.current;
    if (modelBusyRef.current || fast === null) return;
    const store = useChatStore.getState();
    if (store.conversationId !== chatId) return;
    const existing = readVoiceModelState(chatId);
    if (existing && store.sessionModelOverride === existing.fast) {
      // Already switched. A new Fast model pick while Voice mode runs switches again.
      if (existing.fast === fast || !mayRevertVoiceModel(existing, readVoiceMode(chatId))) return;
      writeVoiceModelState(chatId, { ...existing, fast, owner: existing.owner, at: existing.at });
      modelBusyRef.current = true;
      try {
        await store.setModel(fast, { expectConfirmation: true });
      } catch {
        writeVoiceModelState(chatId, existing);
        return;
      } finally {
        modelBusyRef.current = false;
      }
      if (!modelRefs.current.wanted && mayTouchModel()) await revertModel();
      return;
    }
    if (effectiveModelId(options, store.sessionModelOverride, store.llmModel) === fast) return;
    // Saved before the switch, so a reload or crash in the middle still puts the model back.
    writeVoiceModelState(chatId, {
      previous: store.sessionModelOverride,
      fallback: findNativeModelOption(options, store.llmModel)?.id ?? store.llmModel,
      fast,
    });
    modelBusyRef.current = true;
    try {
      await store.setModel(fast, { expectConfirmation: true });
    } catch {
      clearVoiceModelState(chatId);
      return;
    } finally {
      modelBusyRef.current = false;
    }
    // Voice mode ended while the switch was in flight: put the model back now.
    if (!modelRefs.current.wanted && mayTouchModel()) await revertModel();
  }, [chatId, mayTouchModel, revertModel]);
  applyRef.current = applyModel;

  useEffect(() => {
    if (modelWanted) void applyModel();
    else void revertModel();
  }, [modelWanted, fastModel, applyModel, revertModel]);

  // The one retry of a refused restore waits for the turn to go idle.
  useEffect(() => {
    if (revertRetry && chatStatus === "idle" && !modelWanted) void revertModel();
  }, [revertRetry, chatStatus, modelWanted, revertModel]);

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
        {modelAvailable ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="ae-voice-model-trigger">
              <span className={ROW_LABEL_CLASS}>
                Fast model
                <RowHint id="voice.fast_model" />
              </span>
              <span className={ROW_VALUE_CLASS}>{fastModelName}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-[60vh] overflow-y-auto">
              <DropdownMenuRadioGroup
                value={fastModel ?? VOICE_MODEL_OFF}
                onValueChange={(next) => {
                  writeVoiceModelPick(next);
                  setModelPick(next);
                }}
              >
                <DropdownMenuRadioItem value={VOICE_MODEL_OFF} data-testid="ae-voice-model-off">
                  Off (keep the chat's model)
                </DropdownMenuRadioItem>
                {modelOptions.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.id}
                    value={option.id}
                    data-testid="ae-voice-model-option"
                  >
                    {voiceModelLabel(option)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <SwitchRow
          label="Send snips"
          checked={snips}
          onChange={writeSendSnips}
          hint="voice.snips"
          testId="ae-voice-snips"
        />
        <MicWhileSpeakingRow />
        <VoiceChoiceRows choices={choices} />
        <DropdownMenuSeparator />
        <div className="flex gap-1.5 px-1 pb-1 pt-0.5" data-testid="ae-speak-actions">
          <DropdownMenuItem
            onSelect={() => {
              // readLast primes a cloud voice itself, after its stop(), still inside this tap.
              readLast();
            }}
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
        <SendVoiceLogRow chatId={chatId} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
