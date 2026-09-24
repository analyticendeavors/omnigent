// "Open in split view" on a sidebar session's action menu (omnigent-ae patch
// P5, 2026-09-24): adds the session to the remembered split layout (seeded
// with the session being viewed when there is none) and opens `/split`.
// Desktop only; the split route itself falls back to one session below
// 1024px, so the item is not offered there, nor inside a pane.

import { Columns2Icon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import {
  isAeSplitPane,
  layoutWithSession,
  paneSessionFromPath,
  readStoredLayout,
  splitHref,
  writeStoredLayout,
} from "@/lib/aeSplitLayout";
import { useLocation, useNavigate } from "@/lib/routing";
import { useIsSplitViewport } from "@/pages/AeSplitPage";

// The one piece of the sidebar's menu-component bundle this item renders,
// typed structurally so the dropdown and the context-menu families both fit.
interface AeSplitItemComponents {
  Item: ComponentType<{
    children?: ReactNode;
    onSelect?: (event: Event) => void;
    "data-testid"?: string;
  }>;
}

export function AeSplitMenuItem({
  components: C,
  sessionId,
  onDone,
}: {
  components: AeSplitItemComponents;
  sessionId: string;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const desktop = useIsSplitViewport();
  if (!desktop || isAeSplitPane()) return null;
  return (
    <C.Item
      data-testid="ae-split-open"
      onSelect={() => {
        const layout = layoutWithSession(
          readStoredLayout(),
          sessionId,
          paneSessionFromPath(pathname) ?? null,
        );
        writeStoredLayout(layout);
        onDone();
        navigate(splitHref(layout.panes));
      }}
    >
      <Columns2Icon className="size-3.5" />
      Open in split view
    </C.Item>
  );
}
