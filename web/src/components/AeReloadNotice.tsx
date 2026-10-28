import { useEffect } from "react";
import { toast } from "sonner";

import { useIsEmbedded } from "@/lib/embedded";
import { startBuildCheck } from "@/lib/aeBuildCheck";

const TOAST_ID = "ae-reload-notice";

/**
 * Shows one persistent "Omnigent was updated" toast when the server serves a
 * newer build than this tab runs (patch 0214). Renders nothing itself and never
 * reloads on its own. "Later" dismisses it for that build; a different, newer
 * build shows it again.
 */
export function AeReloadNotice() {
  const embedded = useIsEmbedded();
  useEffect(
    () =>
      embedded
        ? undefined
        : startBuildCheck(() => {
            toast("Omnigent was updated.", {
              id: TOAST_ID,
              description: "Reload to get the new version.",
              duration: Number.POSITIVE_INFINITY,
              testId: "ae-reload-notice",
              action: { label: "Reload", onClick: () => window.location.reload() },
              cancel: { label: "Later", onClick: () => toast.dismiss(TOAST_ID) },
            });
          }),
    [embedded],
  );
  return null;
}
