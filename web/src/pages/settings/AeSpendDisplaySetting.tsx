// Settings > Chat > Spend shows (omnigent-ae, 2026-10-24): what the spend pills
// read, saved on this device. Tokens suit a subscription account.

import { useId } from "react";
import { SettingsLabel } from "@/components/SettingsLabel";
import { CardRadioGroup } from "@/components/theme/CardRadioGroup";
import {
  AE_SPEND_DISPLAYS,
  type AeSpendDisplay,
  useAeSpendDisplay,
  writeAeSpendDisplay,
} from "@/lib/aeSpendDisplay";

const CARDS: Record<AeSpendDisplay, { label: string; title: string }> = {
  tokens: { label: "Tokens", title: "Pills show new input plus output tokens." },
  cost: { label: "Cost", title: "Pills show the estimated cost at API rates." },
  both: { label: "Both", title: "Pills show tokens and the estimated cost." },
  off: { label: "Off", title: "No spend on pills, rows or the hover card." },
};

export function AeSpendDisplaySetting() {
  const value = useAeSpendDisplay();
  const labelId = useId();
  return (
    <div data-testid="ae-spend-display" className="flex flex-col gap-3">
      <SettingsLabel
        label="Spend shows"
        labelId={labelId}
        description="Tokens suit a subscription account; cost is an API-price estimate."
      />
      <CardRadioGroup<AeSpendDisplay>
        labelledBy={labelId}
        value={value}
        onSelect={writeAeSpendDisplay}
        componentId="settings.chat.spend_display"
        className="grid grid-cols-1 gap-3 sm:grid-cols-4"
        cardClassName="items-center gap-2 p-4"
        items={AE_SPEND_DISPLAYS.map((mode) => ({
          value: mode,
          testId: `ae-spend-display-${mode}`,
          title: CARDS[mode].title,
          body: <span className="text-ui font-normal md:font-medium">{CARDS[mode].label}</span>,
        }))}
      />
    </div>
  );
}
