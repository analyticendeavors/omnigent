// Settings > Chat: the session list's sort options (omnigent-ae, 2026-10-19).
// Grouping and Ordering live in the list's own filter menu, per device; the
// manual order is saved on the server, so its reset lives here, with an Undo
// that puts the previous order back.

import { QueryClient, QueryClientContext } from "@tanstack/react-query";
import { useContext, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { showToast } from "@/components/ui/toast";
import { aeEnqueueOrder, aeOrderSettled, aeReadOrder, reasonOf } from "@/hooks/useAeSidebarOrder";

const UNDO_MS = 8000;

export function AeSessionListSetting() {
  // Reset and Undo go through the session list's save queue, so a move still
  // saving cannot land after them. Settings also renders without a query
  // client (tests); a local one stands in, with a queue of its own.
  const appClient = useContext(QueryClientContext);
  const [localClient] = useState(() => (appClient ? null : new QueryClient()));
  const queryClient = appClient ?? localClient!;
  const [busy, setBusy] = useState(false);

  const undo = async (previous: readonly string[]) => {
    aeEnqueueOrder(queryClient, { kind: "set", order: previous });
    // A failed save shows the queue's own toast.
    if (await aeOrderSettled(queryClient)) showToast("Manual order restored.");
  };

  const reset = async () => {
    setBusy(true);
    try {
      const current = await aeReadOrder(queryClient);
      if (current.order.length === 0) {
        showToast("The manual order is already empty; the list shows newest first.");
        return;
      }
      aeEnqueueOrder(queryClient, { kind: "set", order: [] });
      if (!(await aeOrderSettled(queryClient))) return;
      toast("Manual order reset", {
        description: "Sessions now list newest first until you move one.",
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => void undo(current.order) },
        testId: "ae-session-order-reset-toast",
      });
    } catch (error) {
      showToast(
        `Could not reset the manual order: ${reasonOf(error)}. Reload the page and try again.`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="ae-session-list-setting"
      className="flex items-start justify-between gap-6 max-sm:flex-col max-sm:gap-2"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-ui font-medium">Session list</span>
        <span className="text-ui text-muted-foreground">
          Pick Triage grouping or Manual ordering from the filter button at the top of the session
          list. The manual order is saved for your account, so it follows you to every device.
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void reset()}
        data-testid="ae-reset-session-order"
        componentId="settings.chat.reset_session_order"
        className="mt-0.5 shrink-0"
      >
        Reset manual order
      </Button>
    </div>
  );
}
