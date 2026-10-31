// The "pin only the parent, or the whole family?" dialog (omnigent-ae,
// 2026-10-31). One host, mounted once in the app shell, shows whatever
// `askPinFamily` (lib/aePinFamilyChoice.ts) asked. Radix's dialog supplies the
// focus trap, focus return and Escape; closing any other way is Cancel.

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
  const question = usePinFamilyQuestion();
  const pin = question?.action !== "unpin";
  return (
    <Dialog open={question !== null} onOpenChange={(open) => !open && answerPinFamily("cancel")}>
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
          <Button data-testid="ae-pin-family-dialog-family" onClick={() => answerPinFamily("family")}>
            {pin ? "Pin the whole family" : "Unpin the whole family"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
