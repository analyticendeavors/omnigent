// Settings > Chat > Pin a lead's family (omnigent-ae, 2026-10-26): whether
// pinning a family's lead pins its open sessions too, saved on this device.
// The cascade: shell/aePinFamily.ts.

import { useId } from "react";
import { SettingsLabel } from "@/components/SettingsLabel";
import { CardRadioGroup } from "@/components/theme/CardRadioGroup";
import { useAePinFamily, writeAePinFamily } from "@/lib/aePinFamily";

type Choice = "yes" | "no";

const CARDS: { value: Choice; label: string; title: string }[] = [
  {
    value: "yes",
    label: "Yes",
    title: "Pinning a lead pins its open sessions; unpinning it unpins the family.",
  },
  { value: "no", label: "No", title: "Pinning a lead pins only the lead." },
];

export function AePinFamilySetting() {
  const on = useAePinFamily();
  const labelId = useId();
  return (
    <div data-testid="ae-pin-family" className="flex flex-col gap-3">
      <SettingsLabel
        label="Pin a lead's family"
        labelId={labelId}
        description="When you pin a family's lead, also pin its open sessions, and unpin them with it."
      />
      <CardRadioGroup<Choice>
        labelledBy={labelId}
        value={on ? "yes" : "no"}
        onSelect={(value) => writeAePinFamily(value === "yes")}
        componentId="settings.chat.pin_family"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        cardClassName="items-center gap-2 p-4"
        items={CARDS.map((card) => ({
          value: card.value,
          testId: `ae-pin-family-${card.value}`,
          title: card.title,
          body: <span className="text-ui font-normal md:font-medium">{card.label}</span>,
        }))}
      />
    </div>
  );
}
