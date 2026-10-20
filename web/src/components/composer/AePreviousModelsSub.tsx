// "Previous models" submenu for the Claude model pickers (omnigent-ae,
// 2026-10-19). The Models section keeps the newest version of each family;
// older versions the subscription still serves sit one level down.

import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type ComposerConfigChoice,
  type ComposerConfigSection,
  ConfigChoices,
} from "./ComposerConfigSections";

/** The older model choices, as the same checkbox rows the Models section uses. */
export function AePreviousModelsSub({
  choices,
  testId,
}: {
  choices: readonly ComposerConfigChoice[];
  testId: string;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid={testId}>Previous models</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[70vh] max-w-[calc(100vw-2rem)] overflow-y-auto">
        <ConfigChoices choices={choices} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** The section with the choices keyed in `previous` moved into the submenu. */
export function aeWithPreviousModels(
  previous: ReadonlySet<string>,
  section: ComposerConfigSection,
): ComposerConfigSection {
  if (previous.size === 0) return section;
  const older = section.choices.filter((choice) => previous.has(choice.key));
  if (older.length === 0) return section;
  return {
    ...section,
    choices: section.choices.filter((choice) => !previous.has(choice.key)),
    trailing: (
      <>
        {section.trailing}
        <AePreviousModelsSub choices={older} testId={`${section.testId}-previous`} />
      </>
    ),
  };
}
