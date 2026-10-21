// The session menu's one-column model list, shared by a chat and New Chat: the
// newest model per family with digit shortcuts, older ones in a Previous models
// (Codex: More models) submenu, and Effort as a submenu naming the current level.

import type { ReactNode } from "react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { aeClaudeVersion, aeSplitPreviousBy } from "@/lib/aeClaudeModels";
import { AE_MENU_ROW_CLASS, AE_MENU_WIDTH_CLASS } from "@/lib/aeMenuRow";
import { cn } from "@/lib/utils";
import type { ComposerConfigChoice } from "./ComposerConfigSections";

export function aeCompactModelChoices(
  choices: ComposerConfigChoice[],
  kind: string | null,
  testIdPrefix = "composer-agent",
): {
  primary: ComposerConfigChoice[];
  more: ComposerConfigChoice[];
  unresolvedCurrent?: ComposerConfigChoice;
} {
  const claudeChoiceVersion = (choice: ComposerConfigChoice) =>
    aeClaudeVersion(choice.data?.["data-model-wire"] ?? "") ??
    aeClaudeVersion(choice.data?.["data-model-id"] ?? choice.key) ??
    (typeof choice.label === "string" ? aeClaudeVersion(choice.label) : null);
  const codexModel = (id: string) =>
    /^gpt-(\d+)(?:\.(\d+))?(?:-(codex|mini|nano|luna|sol|spark|astra))?(?:$|-)/i.exec(id);
  const primary: ComposerConfigChoice[] = [];
  const more: ComposerConfigChoice[] = [];
  const seen = new Set<string>();
  const latestCodexByFamily = new Map<string, { id: string; major: number; minor: number }>();
  if (kind === "claude") {
    let unresolvedCurrent: ComposerConfigChoice | undefined;
    // The new-chat picker's definition of "previous" (omnigent-ae, 2026-10-19).
    const split = aeSplitPreviousBy(choices, claudeChoiceVersion);
    const previous = new Set(split.previous);
    const primaryIndex = new Map<string, number>();
    for (const choice of choices) {
      const id = choice.data?.["data-model-id"] ?? choice.key;
      const version = claudeChoiceVersion(choice);
      const alias = /^(fable|opus|sonnet|haiku)$/i.exec(id)?.[1]?.toLowerCase();
      const latest = split.newest.get(version?.family ?? alias ?? "");
      if (previous.has(choice)) {
        more.push(choice);
        continue;
      }
      // An unversioned alias cannot claim the newest version when the catalog has a versioned row.
      if (!version && alias && latest) {
        if (choice.checked)
          unresolvedCurrent = {
            ...choice,
            label: <>{choice.label} (current, version unknown)</>,
            disabled: true,
            testId: `${testIdPrefix}-current-model`,
          };
        continue;
      }
      const variant = /\[[^\]]+\]/.exec(id)?.[0] ?? "";
      const key = version && `${version.family}:${version.major}.${version.minor}:${variant}`;
      const existingIndex = key ? primaryIndex.get(key) : undefined;
      if (existingIndex !== undefined) {
        const existing = primary[existingIndex];
        const existingId = existing.data?.["data-model-id"] ?? existing.key;
        if (
          (choice.checked && !existing.checked) ||
          (choice.checked === existing.checked &&
            alias &&
            !/^(fable|opus|sonnet|haiku)$/i.test(existingId))
        )
          primary[existingIndex] = choice;
        continue;
      }
      if (key) primaryIndex.set(key, primary.length);
      primary.push(choice);
    }
    return { primary, more, unresolvedCurrent };
  }
  if (kind === "codex") {
    for (const choice of choices) {
      const id = choice.data?.["data-model-id"] ?? choice.key;
      const match = codexModel(id);
      if (!match) continue;
      const family = match[3] ?? "base";
      const major = Number(match[1]);
      const minor = Number(match[2] ?? 0);
      const latest = latestCodexByFamily.get(family);
      if (!latest || major > latest.major || (major === latest.major && minor > latest.minor))
        latestCodexByFamily.set(family, { id, major, minor });
    }
  }
  for (const choice of choices) {
    const id = choice.data?.["data-model-id"] ?? choice.key;
    const codexFamily = kind === "codex" ? codexModel(id) : null;
    const family = codexFamily ? `codex:${codexFamily[1] ?? "base"}` : id;
    const latestCodex =
      codexFamily !== null && latestCodexByFamily.get(codexFamily[3] ?? "base")?.id === id;
    if (choice.checked || (codexFamily ? latestCodex : !seen.has(family))) {
      primary.push(choice);
      seen.add(family);
    } else {
      more.push(choice);
    }
  }
  return { primary, more };
}

function CompactConfigChoice({
  choice,
  shortcut,
  testIdPrefix = "composer-agent",
}: {
  choice: ComposerConfigChoice;
  /** The digit that picks this row while the menu is open. */
  shortcut?: string;
  testIdPrefix?: string;
}) {
  return (
    <DropdownMenuCheckboxItem
      checked={choice.checked}
      disabled={choice.disabled}
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={choice.onSelect}
      data-testid={choice.testId}
      data-model-shortcut={shortcut}
      // The check goes before the name, as desktop Claude Code draws it, which
      // leaves the right edge for the shortcut digit or a tag.
      className={cn(AE_MENU_ROW_CLASS, choice.className)}
      {...choice.data}
    >
      {choice.label}
      {shortcut && (
        <span
          aria-hidden="true"
          className="ml-auto pl-3 text-xs text-muted-foreground"
          data-testid={`${testIdPrefix}-model-shortcut`}
        >
          {shortcut}
        </span>
      )}
    </DropdownMenuCheckboxItem>
  );
}

export function AeCompactSessionChoices({
  models,
  efforts,
  kind,
  testIdPrefix = "composer-agent",
}: {
  models?: { leading?: ReactNode; choices: ComposerConfigChoice[] };
  efforts?: { label: string; value?: string | null; choices: ComposerConfigChoice[] };
  kind: string | null;
  /** Prefix of the container test ids: composer-agent in a chat, new-chat-landing-agent on New Chat. */
  testIdPrefix?: string;
}) {
  const { primary, more, unresolvedCurrent } = aeCompactModelChoices(
    models?.choices ?? [],
    kind,
    testIdPrefix,
  );
  return (
    <>
      {models && (
        <div data-testid={`${testIdPrefix}-models`}>
          {models.leading}
          {unresolvedCurrent && <CompactConfigChoice choice={unresolvedCurrent} />}
          {primary.map((choice, index) => (
            <CompactConfigChoice
              key={choice.key}
              choice={choice}
              shortcut={index < 9 ? String(index + 1) : undefined}
              testIdPrefix={testIdPrefix}
            />
          ))}
        </div>
      )}
      {efforts && (
        <div data-testid={`${testIdPrefix}-efforts`}>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid={`${testIdPrefix}-effort-trigger`} className="pl-7">
              {efforts.label}
              {efforts.value && (
                <span
                  className="ml-auto min-w-0 truncate text-muted-foreground"
                  data-testid={`${testIdPrefix}-effort-current`}
                >
                  {efforts.value}
                </span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className={cn(AE_MENU_WIDTH_CLASS, "max-h-[70vh] overflow-y-auto")}
            >
              {efforts.choices.map((choice) => (
                <CompactConfigChoice key={choice.key} choice={choice} />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </div>
      )}
      {models && more.length > 0 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            data-testid={`${testIdPrefix}-more-models`}
            className="pl-7 [&>svg:last-child]:ml-auto!"
          >
            {kind === "claude" ? "Previous models" : "More models"}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className={cn(AE_MENU_WIDTH_CLASS, "max-h-[70vh] overflow-y-auto")}
          >
            {more.map((choice) => (
              <CompactConfigChoice key={choice.key} choice={choice} />
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
    </>
  );
}
