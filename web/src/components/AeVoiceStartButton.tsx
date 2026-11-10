// The Voice button on the new-chat page (omnigent-ae, 2026-11-10): tap to talk, and the
// first sentence starts a chat that opens with Voice mode on.

import { Volume2Icon } from "lucide-react";
import { AeHint } from "@/components/AeHint";
import { Button } from "@/components/ui/button";
import { isSpeechSupported } from "@/lib/aeSpeakReplies";
import { aeHint } from "@/lib/aeSettingHints";
import { cn } from "@/lib/utils";

export interface AeVoiceStartButtonProps {
  armed: boolean;
  onToggle: () => void;
  disabled?: boolean;
  className?: string;
}

export function AeVoiceStartButton({
  armed,
  onToggle,
  disabled,
  className,
}: AeVoiceStartButtonProps) {
  if (!isSpeechSupported()) return null;
  return (
    <>
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
      <AeHint id="voice.start" />
    </>
  );
}
