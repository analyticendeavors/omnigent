// Settings > Chat: the keys that step through the composer's suggestion
// alternatives. Change records the next key combo pressed anywhere on the page
// (Safari does not focus a clicked button, so the button cannot listen); Esc or
// clicking elsewhere cancels. Saved in this browser (lib/aeSuggestionKeys.ts).

import { useEffect, useId, useRef, useState } from "react";
import { Kbd } from "@/components/KeyboardShortcut";
import { Button } from "@/components/ui/button";
import {
  AE_DEFAULT_SUGGESTION_KEYS,
  aeChordFromEvent,
  aeChordKeys,
  aeChordProblem,
  aeSameChord,
  readAeSuggestionKeys,
  useAeSuggestionKeys,
  writeAeSuggestionKey,
  type AeSuggestionKeyAction,
} from "@/lib/aeSuggestionKeys";

const ROWS: { action: AeSuggestionKeyAction; label: string }[] = [
  { action: "next", label: "Next suggestion" },
  { action: "previous", label: "Previous suggestion" },
];

function KeyRow({ action, label }: { action: AeSuggestionKeyAction; label: string }) {
  const keys = useAeSuggestionKeys();
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const chord = keys[action];
  const isDefault = aeSameChord(chord, AE_DEFAULT_SUGGESTION_KEYS[action]);

  const buttonRef = useRef<HTMLButtonElement>(null);

  const stop = () => {
    setRecording(false);
    setProblem(null);
  };

  useEffect(() => {
    if (!recording) return;
    const done = () => {
      setRecording(false);
      setProblem(null);
    };
    // Capture phase on the window: the combo reaches no app hotkey while recording.
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        done();
        return;
      }
      const pressed = aeChordFromEvent(event);
      if (!pressed) return;
      const why = aeChordProblem(pressed, action, readAeSuggestionKeys());
      if (why) {
        setProblem(why);
        return;
      }
      writeAeSuggestionKey(action, pressed);
      done();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!buttonRef.current?.contains(event.target as Node)) done();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [recording, action]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-ui">{label}</span>
        <div className="flex items-center gap-2">
          {recording ? (
            <span className="text-ui text-muted-foreground">Press a key combo, Esc to cancel</span>
          ) : (
            <span className="flex items-center gap-1" data-testid={`ae-suggestion-key-${action}`}>
              {aeChordKeys(chord).map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={recording}
            data-testid={`ae-suggestion-key-${action}-change`}
            ref={buttonRef}
            componentId={`settings.chat.ae_suggestion_key_${action}`}
            onClick={() => (recording ? stop() : setRecording(true))}
          >
            {recording ? "Cancel" : "Change"}
          </Button>
          {!isDefault && !recording && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={`ae-suggestion-key-${action}-reset`}
              onClick={() => writeAeSuggestionKey(action, null)}
            >
              Reset
            </Button>
          )}
        </div>
      </div>
      {problem && (
        <span role="alert" className="text-ui text-destructive">
          {problem}
        </span>
      )}
    </div>
  );
}

export function AeSuggestionKeysSetting() {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-3" aria-labelledby={labelId} role="group">
      <div className="flex min-w-0 flex-col">
        <span id={labelId} className="text-ui font-medium">
          Suggestion keys
        </span>
        <span className="text-ui text-muted-foreground">
          When the composer offers more than one suggestion, these keys step through them; Tab still
          takes the one shown. Saved in this browser.
        </span>
      </div>
      {ROWS.map((row) => (
        <KeyRow key={row.action} {...row} />
      ))}
    </div>
  );
}
