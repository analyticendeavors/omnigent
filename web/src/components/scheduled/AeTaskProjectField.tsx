// The Project picker on the automation dialog: which project each run session
// is filed into. On create, "Default project" omits the field so the server's
// configured default applies; "No project" leaves runs unfiled.
import { Label } from "@/components/scheduled/Label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProjects } from "@/hooks/useConversations";

/** Select value for "use the server's default project" (create only). */
export const DEFAULT_PROJECT = "__default_project__";
/** Select value for "file runs into no project". */
export const NO_PROJECT = "__no_project__";

/** The picker's starting value for a task being edited, or for a new task. */
export function initialProjectChoice(projectId: string | null | undefined, isEdit: boolean) {
  if (!isEdit) return DEFAULT_PROJECT;
  return projectId ?? NO_PROJECT;
}

/**
 * The `projectId` key to send for *choice*: omitted when it means "server
 * default" or (on edit) when it did not change; `null` for no project.
 */
export function projectIdInput(
  choice: string,
  original: string | null | undefined,
): { projectId?: string | null } {
  if (choice === DEFAULT_PROJECT) return {};
  const projectId = choice === NO_PROJECT ? null : choice;
  if (original !== undefined && projectId === (original ?? null)) return {};
  return { projectId };
}

export function AeTaskProjectField({
  value,
  onValueChange,
  isEdit,
  onSelectOpenChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
  isEdit: boolean;
  onSelectOpenChange?: (open: boolean) => void;
}) {
  const { data } = useProjects();
  // Legacy label-projects carry no id and cannot be filed into.
  const projects = (data ?? []).filter((p): p is typeof p & { id: string } => p.id !== null);
  const knownValue =
    value === DEFAULT_PROJECT || value === NO_PROJECT || projects.some((p) => p.id === value);

  return (
    <div className="flex flex-col gap-1.5" data-testid="task-project-field">
      <Label htmlFor="task-project">Project</Label>
      <Select
        value={value}
        componentId="tasks.scheduled.project"
        onValueChange={onValueChange}
        onOpenChange={onSelectOpenChange}
      >
        <SelectTrigger id="task-project" data-testid="task-project-trigger" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {!isEdit && <SelectItem value={DEFAULT_PROJECT}>Default project</SelectItem>}
          <SelectItem value={NO_PROJECT}>No project</SelectItem>
          {!knownValue && <SelectItem value={value}>Unknown project</SelectItem>}
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-sm text-muted-foreground">
        {value === DEFAULT_PROJECT
          ? "Each run opens in the server's default project, or unfiled when none is set."
          : "Each run opens its session in this project."}
      </p>
    </div>
  );
}
