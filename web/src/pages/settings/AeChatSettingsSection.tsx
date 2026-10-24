// Settings > Chat: options for the chat view. What a session shows when it
// opens lives in the rail's own store (lib/aeSessionRail.ts), saved with its
// layout on this device; the session list's manual order lives on the server
// (AeSessionListSetting).

import { useId } from "react";
import { AeTokenDefragSetting } from "@/components/AeTokenDefrag";
import type { AeRailIconName } from "@/components/aeRail/aeRailIcons";
import { AeRailIcon } from "@/components/aeRail/aeRailUi";
import { SettingsLabel } from "@/components/SettingsLabel";
import { CardRadioGroup } from "@/components/theme/CardRadioGroup";
import { AeSpendDisplaySetting } from "./AeSpendDisplaySetting";
import { AeSessionListSetting } from "./AeSessionListSetting";
import { AeSuggestionKeysSetting } from "./AeSuggestionKeysSetting";
import {
  AE_SESSION_OPEN_VIEWS,
  type AeSessionOpenView,
  useAeSessionRailStore,
} from "@/lib/aeSessionRail";

/** The title and description SettingsPage's `Section` shell gives this section. */
export const AE_CHAT_SETTINGS = {
  title: "Chat",
  description: "How the chat view looks and behaves.",
};

const SESSION_OPEN_VIEW_CARDS: Record<
  AeSessionOpenView,
  { label: string; icon: AeRailIconName; title: string }
> = {
  rail: {
    label: "Session rail",
    icon: "listDetails",
    title: "The rail opens, and a workspace panel left open starts closed.",
  },
  both: {
    label: "Both when they fit",
    icon: "rail",
    title: "The rail opens, and a workspace panel left open stays open when the window fits both.",
  },
  panel: {
    label: "Workspace panel",
    icon: "folder",
    title: "The workspace panel opens as you left it, and the rail does not open by itself.",
  },
};

/** A three-card choice, drawn like Appearance's "Workspace panel" default. */
function SessionOpenViewControl() {
  const value = useAeSessionRailStore((s) => s.sessionOpenView);
  const setValue = useAeSessionRailStore((s) => s.setSessionOpenView);
  const labelId = useId();
  return (
    <div data-testid="ae-session-open-view" className="flex flex-col gap-3">
      <SettingsLabel
        label="When a session opens, show"
        labelId={labelId}
        description="On a desktop window. A link to a file, an agent or a comment still opens the workspace panel, and you can open either one by hand. Phones keep the rail in the session menu."
      />
      <CardRadioGroup<AeSessionOpenView>
        labelledBy={labelId}
        value={value}
        onSelect={setValue}
        componentId="settings.chat.session_open_view"
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        cardClassName="items-center gap-2 p-4"
        items={AE_SESSION_OPEN_VIEWS.map((view) => {
          const card = SESSION_OPEN_VIEW_CARDS[view];
          return {
            value: view,
            testId: `ae-session-open-view-${view}`,
            title: card.title,
            body: (
              <>
                <AeRailIcon name={card.icon} className="size-6 text-muted-foreground" />
                <span className="text-ui font-normal md:font-medium">{card.label}</span>
              </>
            ),
          };
        })}
      />
    </div>
  );
}

export function AeChatSettingsSection() {
  return (
    <div data-testid="ae-chat-settings" className="flex flex-col gap-6">
      <SessionOpenViewControl />
      <AeSpendDisplaySetting />
      <AeTokenDefragSetting />
      <AeSuggestionKeysSetting />
      <AeSessionListSetting />
    </div>
  );
}
