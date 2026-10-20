// The fork dialog's Claude account row: which of the host's Claude
// subscription logins the forked Claude Code session signs in with. Shown only
// for a Claude native fork that stays on the source session's host, since the
// server checks the pick against that host's detected logins.

import { useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type DetectedCredential, useDetectedCredentials } from "@/hooks/useHosts";
import { AeSharedAccountMarker, aeIsSharedAccount } from "@/lib/aeSharedClaudeAccounts";

/** The session label the runner reads at Claude launch (server-internal). */
export const AE_CLAUDE_ACCOUNT_LABEL = "omnigent.claude_native.account";

const SAME_ACCOUNT = "__same__";
// Radix Select items cannot carry an empty value; the default CLI login is "".
const DEFAULT_LOGIN = "__default_login__";

export interface AeForkClaudeAccountChoice {
  /** Account name the fork request sends; "" is the default CLI login. */
  account: string;
  label: string;
}

/** The host's Claude subscription logins, in the order the host reports them. */
export function aeForkClaudeAccounts(
  rows: readonly DetectedCredential[],
): AeForkClaudeAccountChoice[] {
  const seen = new Set<string>();
  const choices: AeForkClaudeAccountChoice[] = [];
  for (const row of rows) {
    if (!row.family.startsWith("claude-oauth")) continue;
    const account = row.env_var ?? "";
    if (seen.has(account)) continue;
    seen.add(account);
    choices.push({ account, label: row.source || (account === "" ? "Default login" : account) });
  }
  return choices;
}

/**
 * @param hostId - The source session's host, whose logins are listed.
 * @param currentAccount - The source session's account label, if any.
 * @param value - The picked account, or `undefined` to keep the source's.
 * @param onChange - Receives the new pick (`undefined` for "Same as this session").
 */
export function AeForkClaudeAccount({
  hostId,
  currentAccount,
  value,
  onChange,
}: {
  hostId: string;
  currentAccount: string | undefined;
  value: string | undefined;
  onChange: (account: string | undefined) => void;
}) {
  const { data: credentials = [] } = useDetectedCredentials(hostId, true);
  const accounts = aeForkClaudeAccounts(credentials);
  // The server refuses any pick on a host signed in with provider credentials.
  const providerAuth = credentials.some((row) => row.family.startsWith("claude-provider"));
  // A pick the host stopped offering falls back to the source's account.
  const stalePick =
    value !== undefined && (providerAuth || !accounts.some((choice) => choice.account === value));
  useEffect(() => {
    if (stalePick) onChange(undefined);
  }, [stalePick, onChange]);
  if (accounts.length === 0 || providerAuth) return null;
  // An unlabelled source runs on the host's account for new chats, not a named login.
  const current =
    currentAccount === undefined
      ? undefined
      : accounts.find((choice) => choice.account === currentAccount);
  const sameLabel =
    currentAccount === undefined
      ? "Same as this session"
      : `Same as this session (${current ? current.label : "unavailable"})`;
  const selected =
    value === undefined || stalePick ? SAME_ACCOUNT : value === "" ? DEFAULT_LOGIN : value;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-muted-foreground">Claude account</span>
      <Select
        value={selected}
        onValueChange={(next) =>
          onChange(next === SAME_ACCOUNT ? undefined : next === DEFAULT_LOGIN ? "" : next)
        }
        componentId="fork_session.config.claude_account"
      >
        <SelectTrigger
          className="w-full cursor-pointer text-sm"
          data-testid="fork-session-config-claude-account"
          aria-label="Claude account"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          position="popper"
          align="start"
          className="[&_[data-slot=select-item]]:text-sm"
        >
          <SelectItem value={SAME_ACCOUNT}>{sameLabel}</SelectItem>
          {accounts.map((choice) => (
            <SelectItem
              key={choice.account || DEFAULT_LOGIN}
              value={choice.account === "" ? DEFAULT_LOGIN : choice.account}
            >
              {choice.label}
              {aeIsSharedAccount(choice.account) && <AeSharedAccountMarker />}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
