// The "pin only the parent, or the whole family?" dialog (omnigent-ae,
// 2026-10-31). One host, mounted once in the app shell, shows whatever
// `askPinFamily` (lib/aePinFamilyChoice.ts) asked. Radix's dialog supplies the
// focus trap, focus return and Escape; closing any other way is Cancel.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { answerPinFamily, usePinFamilyQuestion } from "@/lib/aePinFamilyChoice";

export function AePinFamilyChoiceHost() {
  const asked = usePinFamilyQuestion();
  // Radix animates the dialog out after the question clears: keep drawing the last one.
  const [kept, setKept] = useState(asked);
  useEffect(() => {
    if (asked) setKept(asked);
  }, [asked]);
  const question = asked ?? kept;
  const pin = question?.action !== "unpin";
  return (
    <Dialog open={asked !== null} onOpenChange={(open) => !open && answerPinFamily("cancel")}>
      <DialogContent showCloseButton={false} data-testid="ae-pin-family-dialog">
        <DialogHeader>
          <DialogTitle>
            {pin
              ? "Pin only the parent, or the parent and its whole family?"
              : "Unpin only the parent, or the whole family?"}
          </DialogTitle>
          <DialogDescription>
            {question?.title
              ? `"${question.title}" leads a family of sessions.`
              : "This session leads a family of sessions."}
          </DialogDescription>
          {question?.familyBlocked && (
            <p role="status" className="text-ui text-destructive">
              {question.familyBlocked}
            </p>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            data-testid="ae-pin-family-dialog-cancel"
            onClick={() => answerPinFamily("cancel")}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            data-testid="ae-pin-family-dialog-parent"
            onClick={() => answerPinFamily("parent")}
          >
            {pin ? "Pin only the parent" : "Unpin only the parent"}
          </Button>
          <Button
            data-testid="ae-pin-family-dialog-family"
            disabled={!!question?.familyBlocked}
            onClick={() => answerPinFamily("family")}
          >
            {pin ? "Pin the whole family" : "Unpin the whole family"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
