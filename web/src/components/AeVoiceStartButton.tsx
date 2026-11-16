// The Voice button on the new-chat page (omnigent-ae, 2026-11-10): tap to talk, and the
// first sentence starts a chat that opens with Voice mode on. The chevron beside it
// (2026-11-16) opens the per-device voice choices that need no chat, and Send voice log.

import { ChevronDownIcon, Volume2Icon } from "lucide-react";
import {
  MicWhileSpeakingRow,
  SendVoiceLogRow,
  SwitchRow,
  useVoiceChoices,
  VoiceChoiceRows,
} from "@/components/AeVoiceMenuRows";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isSpeechSupported } from "@/lib/aeSpeakReplies";
import { aeHint } from "@/lib/aeSettingHints";
import { cn } from "@/lib/utils";

export interface AeVoiceStartButtonProps {
  armed: boolean;
  onToggle: () => void;
  disabled?: boolean;
  className?: string;
}

/** Mounted only while the menu is open, so the voice lists load on demand. */
function VoiceStartMenuRows({ armed, onToggle }: { armed: boolean; onToggle: () => void }) {
  const choices = useVoiceChoices();
  return (
    <>
      <SwitchRow
        label="Voice mode"
        checked={armed}
        onChange={onToggle}
        hint="voice.start"
        testId="ae-voice-start-toggle"
      />
      <DropdownMenuSeparator />
      <MicWhileSpeakingRow />
      <VoiceChoiceRows choices={choices} />
      <DropdownMenuSeparator />
      <SendVoiceLogRow />
    </>
  );
}

export function AeVoiceStartButton({
  armed,
  onToggle,
  disabled,
  className,
}: AeVoiceStartButtonProps) {
  if (!isSpeechSupported()) return null;
  return (
    <DropdownMenu>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Voice mode"
        aria-pressed={armed}
        title={aeHint("voice.start")}
        data-testid="ae-voice-start"
        disabled={disabled}
        onClick={onToggle}
        className={cn(armed && "text-teal-500 ring-1 ring-teal-500/60", className)}
      >
        <Volume2Icon />
      </Button>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="-ml-1 h-7 w-4 text-muted-foreground pointer-coarse:ml-0 pointer-coarse:h-11 pointer-coarse:w-9"
          aria-label="Voice mode menu"
          data-testid="ae-voice-start-menu"
          disabled={disabled}
        >
          <ChevronDownIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-61 overflow-y-auto">
        <VoiceStartMenuRows armed={armed} onToggle={onToggle} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
