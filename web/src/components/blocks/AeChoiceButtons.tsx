// AE: one button per choice for a single-choice form prompt. Detection and
// labels live in `@/lib/aeChoiceButtons`; the card passes `onChoose` the same
// submit path the schema form uses, and `onReject` its own decline.

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { aeChoiceIsNo, aeChoiceIsPrimary, type AeChoiceField } from "@/lib/aeChoiceButtons";

export function AeChoiceButtons({
  field,
  onChoose,
  onReject,
}: {
  field: AeChoiceField;
  onChoose: (content: Record<string, string>) => void;
  onReject: () => void;
}) {
  // One tap only: a double tap must not post the verdict twice.
  const [sent, setSent] = useState(false);
  const descId = useId();
  const once = (fn: () => void) => () => {
    if (sent) return;
    setSent(true);
    fn();
  };
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2 border-0 p-0 pt-1"
      data-testid="approval-card-choices"
      aria-describedby={field.description ? descId : undefined}
    >
      {field.title && <legend className="p-0 font-medium text-foreground">{field.title}</legend>}
      {field.description && (
        <span id={descId} className="text-sm">
          {field.description}
        </span>
      )}
      <div className="flex min-w-0 flex-wrap gap-2">
        {field.choices.map((choice, index) => (
          <Button
            key={choice.value}
            size="sm"
            variant={
              aeChoiceIsPrimary(choice, index)
                ? "default"
                : aeChoiceIsNo(choice)
                  ? "outline"
                  : "secondary"
            }
            // A long label wraps inside the card instead of running past the screen.
            className="h-auto min-h-7 max-w-full min-w-0 shrink justify-start py-0.5 text-left whitespace-normal"
            title={choice.fullLabel}
            aria-label={choice.fullLabel}
            disabled={sent}
            onClick={once(() => onChoose({ [field.name]: choice.value }))}
          >
            {choice.label}
          </Button>
        ))}
        {field.needsReject && (
          <Button size="sm" variant="ghost" disabled={sent} onClick={once(onReject)}>
            Reject
          </Button>
        )}
      </div>
    </fieldset>
  );
}
