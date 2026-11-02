// The Claude account picker on the automation dialog: which login every run
// signs in with. "Follow the active account" stores no pin, so a run uses
// whichever account the host has selected when it fires.
import { Label } from "@/components/scheduled/Label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDetectedCredentials } from "@/hooks/useHosts";
import { DEFAULT_LOGIN_ACCOUNT, FOLLOW_ACTIVE_ACCOUNT } from "@/lib/aeTaskClaudeAccount";
import { AeSharedAccountMarker, aeIsSharedAccount } from "@/lib/aeSharedClaudeAccounts";
import { aeForkClaudeAccounts } from "@/shell/AeForkClaudeAccount";

/**
 * @param value - The picked choice (see `accountChoiceFor`).
 * @param hostId - The host whose logins are listed; `undefined` lists the server's shared accounts only.
 */
export function AeTaskClaudeAccountField({
  value,
  onValueChange,
  hostId,
  onSelectOpenChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
  hostId: string | undefined;
  onSelectOpenChange?: (open: boolean) => void;
}) {
  const { data: credentials = [] } = useDetectedCredentials(hostId, true);
  const accounts = aeForkClaudeAccounts(credentials);
  // A saved pin the host no longer lists stays visible rather than silently changing.
  const known =
    value === FOLLOW_ACTIVE_ACCOUNT ||
    value === DEFAULT_LOGIN_ACCOUNT ||
    accounts.some((choice) => choice.account === value);
  return (
    <div className="flex flex-col gap-1.5" data-testid="task-claude-account-field">
      <Label htmlFor="task-claude-account">Claude account</Label>
      <Select
        value={value}
        componentId="tasks.scheduled.claude_account"
        onValueChange={onValueChange}
        onOpenChange={onSelectOpenChange}
      >
        <SelectTrigger
          id="task-claude-account"
          data-testid="task-claude-account-trigger"
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={FOLLOW_ACTIVE_ACCOUNT}>Follow the active account</SelectItem>
          {!known && <SelectItem value={value}>{value} (not listed)</SelectItem>}
          {accounts.map((choice) => (
            <SelectItem
              key={choice.account || DEFAULT_LOGIN_ACCOUNT}
              value={choice.account === "" ? DEFAULT_LOGIN_ACCOUNT : choice.account}
            >
              {choice.label}
              {aeIsSharedAccount(choice.account) && <AeSharedAccountMarker />}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-sm text-muted-foreground">
        {value === FOLLOW_ACTIVE_ACCOUNT
          ? "Each run uses whichever Claude account the host has active when it fires."
          : "Every run signs in with this account, even when the host switches to another."}
      </p>
    </div>
  );
}
