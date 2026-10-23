// Settings > Roles: the New preset form, which starts as a copy of the open
// preset's roles and rules, and the same form editing a preset's details. The
// icon comes from the project icon picker (Tabler), plus one of eight colors.

import { type CSSProperties, useId, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { AeTablerIconPicker } from "@/components/AeTablerIconPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AE_PRESET_DESCRIPTION_MAX,
  AE_PRESET_SHORTCUTS,
  AE_PRESET_TITLE_MAX,
  AE_PRESET_WHEN_MAX,
  AE_ROLE_COLOR_CLASSES,
  AE_ROLE_COLORS,
  type AeRoleColor,
  aeOneLine,
} from "@/lib/aeRoles";
import { aeTablerName } from "@/lib/aeTablerIcon";
import { cn } from "@/lib/utils";
import { AeRolePresetTile } from "./AeRolesControls";

export interface AePresetDetails {
  title: string;
  icon: string;
  color: AeRoleColor;
  description: string;
  when_to_use: string;
  makeDefault: boolean;
}

const FIELD =
  "w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground";

export function AeRolesPresetForm({
  mode,
  initial,
  sourceTitle,
  position,
  isDefault,
  saving,
  onCancel,
  onSubmit,
}: {
  mode: "new" | "edit";
  initial: Omit<AePresetDetails, "makeDefault">;
  /** The preset the new one copies its roles from. */
  sourceTitle: string;
  /** Zero-based list position, for the "Alt N" shortcut it gets. */
  position: number;
  isDefault: boolean;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (details: AePresetDetails) => void;
}) {
  const [details, setDetails] = useState<AePresetDetails>({ ...initial, makeDefault: isDefault });
  const [pickerOpen, setPickerOpen] = useState(false);
  const ids = { title: useId(), description: useId(), when: useId(), shortcut: useId() };
  const set = (patch: Partial<AePresetDetails>) => setDetails((d) => ({ ...d, ...patch }));
  const title = aeOneLine(details.title);
  const shortcut =
    position < AE_PRESET_SHORTCUTS ? `Alt ${position + 1}` : "None (only the first 9 get one)";
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        data-testid="ae-preset-form"
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title) return;
            onSubmit({
              ...details,
              title,
              description: aeOneLine(details.description),
              when_to_use: aeOneLine(details.when_to_use),
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{mode === "new" ? "New preset" : "Edit preset"}</DialogTitle>
            <DialogDescription>
              {mode === "new"
                ? `Starting from: ${sourceTitle}. Roles and model changes are copied; edit them after you create it.`
                : "Name, icon and notes. Roles are edited in the table."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.title} className="text-xs text-muted-foreground">
              Icon and name
            </label>
            <div className="flex gap-2">
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Icon and color"
                    data-testid="ae-preset-icon-button"
                    className="flex shrink-0 items-center gap-1 rounded-md border border-input px-1.5"
                  >
                    <AeRolePresetTile icon={details.icon} color={details.color} size="sm" />
                    <ChevronDownIcon className="size-3 text-muted-foreground" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  collisionPadding={8}
                  style={
                    {
                      "--emoji-picker-height":
                        "min(320px, calc(var(--radix-popover-content-available-height) - 80px))",
                    } as CSSProperties
                  }
                  className="emoji-picker-popover flex w-auto flex-col p-0"
                >
                  <AeTablerIconPicker
                    onSelect={(value) => {
                      const name = aeTablerName(value);
                      if (name) set({ icon: name });
                    }}
                  />
                  <div
                    role="radiogroup"
                    aria-label="Color"
                    className="flex items-center gap-2 border-t border-border px-3 py-2.5"
                  >
                    {AE_ROLE_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        role="radio"
                        aria-checked={details.color === color}
                        aria-label={color}
                        onClick={() => set({ color })}
                        className={cn(
                          "size-5 rounded-full",
                          AE_ROLE_COLOR_CLASSES[color].swatch,
                          details.color === color &&
                            "ring-2 ring-foreground ring-offset-2 ring-offset-popover",
                        )}
                      />
                    ))}
                  </div>
                  <p className="px-3 pb-2 text-[11px] text-muted-foreground">
                    Tabler icons, same set as project icons
                  </p>
                </PopoverContent>
              </Popover>
              <input
                id={ids.title}
                required
                autoFocus
                maxLength={AE_PRESET_TITLE_MAX}
                value={details.title}
                onChange={(e) => set({ title: e.target.value })}
                placeholder="Hotfix"
                className={FIELD}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.description} className="text-xs text-muted-foreground">
              Description, shown on the card
            </label>
            <input
              id={ids.description}
              maxLength={AE_PRESET_DESCRIPTION_MAX}
              value={details.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="Opus high for the fix, Sonnet checks it"
              className={FIELD}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.when} className="text-xs text-muted-foreground">
              When to use <span className="opacity-80">(the lead reads this for “Lead picks”)</span>
            </label>
            <textarea
              id={ids.when}
              rows={3}
              maxLength={AE_PRESET_WHEN_MAX}
              value={details.when_to_use}
              onChange={(e) => set({ when_to_use: e.target.value })}
              placeholder="A production bug with a known symptom that has to ship today."
              className={cn(FIELD, "resize-y")}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span id={ids.shortcut} className="text-xs text-muted-foreground">
              Shortcut
            </span>
            <p aria-labelledby={ids.shortcut} className={cn(FIELD, "text-muted-foreground")}>
              {shortcut}
              <span className="block text-[11px]">
                Set by list position; drag in All presets to change it.
              </span>
            </p>
          </div>

          <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={details.makeDefault}
                disabled={mode === "edit" && isDefault}
                onChange={(e) => set({ makeDefault: e.target.checked })}
              />
              Make my default
            </label>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!title || saving}>
                {mode === "new" ? "Create" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
