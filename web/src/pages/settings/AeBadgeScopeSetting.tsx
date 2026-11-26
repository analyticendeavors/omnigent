// Settings > Chat > App icon badge counts (omnigent-ae, 2026-11-26): which
// working sessions the installed app's icon badge counts, saved on this device.

import { useId } from "react";
import { SettingsLabel } from "@/components/SettingsLabel";
import { CardRadioGroup } from "@/components/theme/CardRadioGroup";
import { aeHint } from "@/lib/aeSettingHints";
import {
  AE_BADGE_SCOPES,
  type AeBadgeScope,
  useAeBadgeScope,
  writeAeBadgeScope,
} from "@/lib/aeBadgeScope";

const CARDS: Record<AeBadgeScope, { label: string; title: string }> = {
  "top-level": {
    label: "Top-level sessions",
    title: "The badge counts working solo and parent sessions, as the Session Dashboard does.",
  },
  all: { label: "All sessions", title: "The badge also counts working child and helper sessions." },
};

export function AeBadgeScopeSetting() {
  const value = useAeBadgeScope();
  const labelId = useId();
  return (
    <div data-testid="ae-badge-scope" className="flex flex-col gap-3">
      <SettingsLabel
        label="App icon badge counts"
        labelId={labelId}
        description={aeHint("chat.badge_scope")}
      />
      <CardRadioGroup<AeBadgeScope>
        labelledBy={labelId}
        value={value}
        onSelect={writeAeBadgeScope}
        componentId="settings.chat.badge_scope"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        cardClassName="items-center gap-2 p-4"
        items={AE_BADGE_SCOPES.map((scope) => ({
          value: scope,
          testId: `ae-badge-scope-${scope}`,
          title: CARDS[scope].title,
          body: <span className="text-ui font-normal md:font-medium">{CARDS[scope].label}</span>,
        }))}
      />
    </div>
  );
}
