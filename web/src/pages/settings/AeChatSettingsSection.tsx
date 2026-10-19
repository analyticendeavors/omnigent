// Settings > Chat: options for the chat view. The rail preference lives in the
// rail's own store (lib/aeSessionRail.ts), saved with its layout on this device.

import { useId } from "react";
import { AeTokenDefragSetting } from "@/components/AeTokenDefrag";
import { Switch } from "@/components/ui/switch";
import { useAeSessionRailStore } from "@/lib/aeSessionRail";

/** The title and description SettingsPage's `Section` shell gives this section. */
export const AE_CHAT_SETTINGS = {
  title: "Chat",
  description: "How the chat view looks and behaves.",
};

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
          The rail opens whenever you open a session; on narrower windows a workspace panel left
          open starts closed instead. Phones keep the rail in the session menu.
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
    <div data-testid="ae-chat-settings" className="flex flex-col gap-6">
      <OpenRailInEverySessionControl />
      <AeTokenDefragSetting />
    </div>
  );
}
