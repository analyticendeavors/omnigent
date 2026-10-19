// Settings > Chat (omnigent-ae, 2026-10-18): options for the chat view. Its
// first option is the session rail's "open in every session" preference,
// which lives in the rail's own store (lib/aeSessionRail.ts) and is saved with
// the rail's layout on this device.

import { useId } from "react";
import { Switch } from "@/components/ui/switch";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";
import { cn } from "@/lib/utils";

// message-circle, copied from @tabler/icons (tabler-nodes-outline.json).
const MESSAGE_CIRCLE: AeTablerIconNode = [
  [
    "path",
    {
      d: "M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293l-4.7 1",
    },
  ],
];

/** The Chat section's nav icon (Tabler message-circle). */
export function AeChatSettingsIcon({ className }: { className?: string }) {
  return <AeTablerSvg node={MESSAGE_CIRCLE} className={cn("size-4 shrink-0", className)} />;
}

function OpenRailInEverySessionControl() {
  const value = useAeSessionRailStore((s) => s.openInEverySession);
  const setValue = useAeSessionRailStore((s) => s.setOpenInEverySession);
  const labelId = useId();
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex min-w-0 flex-1 flex-col">
        <span id={labelId} className="text-ui font-medium">
          Open the session rail in every session
        </span>
        <span className="text-ui text-muted-foreground">
          The rail opens whenever you open a session; on narrower windows a workspace, files or logs
          panel that will not fit beside it closes instead. Phones keep the rail in the session
          menu.
        </span>
      </div>
      <Switch
        aria-labelledby={labelId}
        checked={value}
        onCheckedChange={setValue}
        data-testid="ae-open-rail-every-session"
        className="mt-0.5 shrink-0"
        componentId="settings.chat.open_rail_every_session"
      />
    </div>
  );
}

export function AeChatSettingsSection() {
  return (
    <section data-testid="ae-chat-settings">
      <h1 className="text-2xl font-semibold">Chat</h1>
      <p className="mt-1 text-ui text-muted-foreground">How the chat view looks and behaves.</p>
      <div className="mt-6 flex flex-col gap-6">
        <OpenRailInEverySessionControl />
      </div>
    </section>
  );
}
