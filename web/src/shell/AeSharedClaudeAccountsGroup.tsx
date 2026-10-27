// The Shared group under Settings' Claude accounts (omnigent-ae, 2026-10-20):
// the company Claude accounts the admin keeps for every user, each with its id
// and who added it. Everyone sees the list and can select an account for new
// chats; an admin also gets Rename, Remove and + Add. The server checks admin
// on every change, so those controls are only chrome.

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type DetectedCredential,
  useInvalidateDetectedCredentials,
  useStoreCredential,
} from "@/hooks/useHosts";
import { getCurrentIsAdmin } from "@/lib/identity";
import {
  AE_USERS_GROUP_ICON,
  type AeSharedClaudeAccountDetail,
  type AeSharedClaudeAccountList,
  aeAddSharedClaudeAccount,
  aeIsSharedAccount,
  aeReadSharedClaudeAccounts,
  aeRelabelSharedClaudeAccount,
  aeRemoveSharedClaudeAccount,
} from "@/lib/aeSharedClaudeAccounts";
import { aePickDefaultClaudeAccount } from "@/lib/aePickDefaultClaudeAccount";
import { AE_PENCIL_ICON } from "@/lib/aePolicyEdit";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";

/** Tabler `plus` and `trash` (outline, @tabler/icons 3.46.0), inlined. */
const PLUS_ICON: AeTablerIconNode = [
  ["path", { d: "M12 5l0 14" }],
  ["path", { d: "M5 12l14 0" }],
];
const TRASH_ICON: AeTablerIconNode = [
  ["path", { d: "M4 7l16 0" }],
  ["path", { d: "M10 11l0 6" }],
  ["path", { d: "M14 11l0 6" }],
  ["path", { d: "M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" }],
  ["path", { d: "M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" }],
];

const KEY_ENV = "AE_SHARED_ACCOUNTS_KEY";

/** A row of the group: a listed account, or a host's pick the server no longer lists. */
interface SharedRow {
  account: string;
  label: string;
  detail: AeSharedClaudeAccountDetail | null;
}

/** The muted line under a row's label: its id and who added it. */
export function aeSharedAccountMeta(row: SharedRow): string {
  const items = [row.account];
  if (row.detail?.created_by) {
    const added = Date.parse(row.detail.created_at);
    items.push(
      Number.isNaN(added)
        ? `Added by ${row.detail.created_by}`
        : `Added by ${row.detail.created_by}, ${new Date(added).toLocaleDateString([], { month: "short", day: "numeric" })}`,
    );
  }
  return items.join(" · ");
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Request failed";
}

export function AeSharedClaudeAccountsGroup({
  hostId,
  rows,
  onChanged,
}: {
  hostId: string;
  /** The host's account rows, which say which shared account it has selected. */
  rows: readonly DetectedCredential[];
  /** Called after a change so the host's pickers read the pool again. */
  onChanged: () => void;
}) {
  const store = useStoreCredential(hostId);
  const pickDefault = aePickDefaultClaudeAccount(store, hostId);
  const invalidateAllHosts = useInvalidateDetectedCredentials();
  const [list, setList] = useState<AeSharedClaudeAccountList | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [token, setToken] = useState("");
  const mounted = useRef(true);
  const addButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const wasAdding = useRef(false);
  const editInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(
    () =>
      aeReadSharedClaudeAccounts().then(
        (answer) => {
          if (!mounted.current) return;
          setList(answer);
          setReadError(null);
        },
        (error: unknown) => {
          if (mounted.current) setReadError(errorText(error));
        },
      ),
    [],
  );
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  // Keyboard focus follows the form: into Name when it opens, back to + Add when it closes.
  useEffect(() => {
    if (adding) nameInput.current?.focus();
    else if (wasAdding.current) addButton.current?.focus();
    wasAdding.current = adding;
  }, [adding]);

  useEffect(() => {
    if (editing) editInput.current?.focus();
  }, [editing]);

  const say = (text: string, isError: boolean) => {
    setMessageIsError(isError);
    setMessage(text);
  };
  /** Run one change, say its outcome, then read the pool again. */
  const change = async (run: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await run();
      if (mounted.current) say(done, false);
    } catch (error) {
      if (mounted.current) say(errorText(error), true);
    } finally {
      if (mounted.current) setBusy(false);
    }
    await refresh();
    invalidateAllHosts();
    onChanged();
  };

  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    const input = { name: name.trim(), label: newLabel.trim() || undefined, token: token.trim() };
    // The token never outlives the submit, whatever the answer.
    setToken("");
    if (!input.name || !input.token) {
      say("Enter a name and the OAuth token.", true);
      return;
    }
    void change(
      async () => {
        await aeAddSharedClaudeAccount(input);
        setName("");
        setNewLabel("");
        setAdding(false);
      },
      `Added ${input.label ?? input.name}. It shows in every account picker now.`,
    );
  };
  const closeAdd = () => {
    setAdding(false);
    setName("");
    setNewLabel("");
    setToken("");
  };

  const hostShared = rows.filter(
    (row) => row.family.startsWith("claude-oauth") && aeIsSharedAccount(row.env_var),
  );
  const selected = hostShared.find((row) => row.family === "claude-oauth-active")?.env_var;
  const listed = list?.accounts ?? [];
  const known = new Set(listed.map((account) => account.account));
  const shown: SharedRow[] = [
    ...listed.map((account) => ({
      account: account.account,
      label: account.label,
      detail: account,
    })),
    ...hostShared
      .filter((row) => !known.has(row.env_var ?? ""))
      .map((row) => ({ account: row.env_var ?? "", label: row.source, detail: null })),
  ];
  // Admin is the server's /v1/me answer; can_manage is the same answer, and
  // also covers a single-user install, where /v1/me names nobody.
  const manage = getCurrentIsAdmin() || list?.can_manage === true;
  if (!manage && shown.length === 0 && !list) return null;

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="ae-shared-claude-accounts">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1 text-sm font-medium">
          <AeTablerSvg node={AE_USERS_GROUP_ICON} className="size-4 shrink-0" />
          Shared
        </span>
        {manage && !adding && (
          <Button
            ref={addButton}
            type="button"
            variant="outline"
            size="sm"
            aria-label="Add shared account"
            onClick={() => {
              setAdding(true);
              setMessage("");
            }}
          >
            <AeTablerSvg node={PLUS_ICON} className="size-3.5" />
            Add
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Company Claude accounts the admin keeps for every user.
        {manage ? "" : " Only an admin can add or change them."}
      </p>
      {list && !list.key_configured && (
        <p className="text-xs text-destructive">
          {KEY_ENV} is not set on the server, so shared accounts cannot be added or used.
          deploy/README.md, Shared Claude accounts, says how to set it.
        </p>
      )}
      {readError && (
        <p className="text-xs text-destructive">
          The shared accounts could not be read ({readError}).
        </p>
      )}
      {list && shown.length === 0 && (
        <p className="text-xs text-muted-foreground">No shared Claude accounts yet.</p>
      )}
      {shown.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-2">
          {shown.map((row) => {
            const isSelected = row.account === selected;
            const accountName = row.detail?.name;
            return (
              <div
                key={row.account}
                className="flex min-w-[10rem] flex-[1_1_10rem] flex-col gap-1 rounded border p-2"
                data-account={row.account}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto min-h-8 min-w-0 flex-1 whitespace-normal break-words"
                    disabled={store.isPending || busy || isSelected}
                    onClick={() =>
                      pickDefault(row.account, row.label, {
                        onSuccess: () => say("Account selected for new chats.", false),
                        onError: (error) => say(error.message, true),
                      })
                    }
                  >
                    {row.label}
                    {isSelected ? " (selected)" : ""}
                  </Button>
                  {manage && accountName && editing !== row.account && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-foreground"
                        title="Change the label every picker shows"
                        aria-label={`Rename ${row.label}`}
                        disabled={busy}
                        onClick={() => {
                          setEditing(row.account);
                          setLabel(row.label);
                          setConfirming(null);
                          setMessage("");
                        }}
                      >
                        <AeTablerSvg node={AE_PENCIL_ICON} className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        title="Delete the account and its token for everyone"
                        aria-label={`Remove ${row.label}`}
                        disabled={busy}
                        onClick={() => {
                          setConfirming(row.account);
                          setEditing(null);
                          setMessage("");
                        }}
                      >
                        <AeTablerSvg node={TRASH_ICON} className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
                <p className="px-2 text-xs text-muted-foreground">{aeSharedAccountMeta(row)}</p>
                {manage && accountName && editing === row.account && (
                  <div className="flex min-w-0 flex-wrap gap-1">
                    <Input
                      ref={editInput}
                      aria-label={`New label for ${row.label}`}
                      className="min-w-0 flex-1"
                      value={label}
                      maxLength={64}
                      disabled={busy}
                      onChange={(event) => setLabel(event.target.value)}
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || !label.trim()}
                      onClick={() =>
                        void change(async () => {
                          await aeRelabelSharedClaudeAccount(accountName, label.trim());
                          setEditing(null);
                        }, `Renamed to ${label.trim()}.`)
                      }
                    >
                      Save name
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
                {manage && accountName && confirming === row.account && (
                  <div className="flex min-w-0 flex-wrap items-center gap-1">
                    <span className="min-w-0 flex-1 text-xs">
                      Hosts that selected it stop working until they pick another account.
                    </span>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(null);
                        void change(
                          () => aeRemoveSharedClaudeAccount(accountName),
                          `Removed ${row.label}.`,
                        );
                      }}
                    >
                      Remove for everyone
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {manage && adding && (
        <form
          className="flex min-w-0 flex-col gap-2"
          aria-label="Add shared account"
          onSubmit={submitAdd}
        >
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            Name
            <Input
              ref={nameInput}
              aria-label="Name"
              aria-describedby="ae-shared-name-help"
              value={name}
              maxLength={64}
              autoComplete="off"
              placeholder="Team"
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
            <span id="ae-shared-name-help" className="text-muted-foreground">
              Letters, digits, spaces, - or _. Hosts select it as shared:Name.
            </span>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            Label (optional)
            <Input
              aria-label="Label (optional)"
              aria-describedby="ae-shared-label-help"
              value={newLabel}
              maxLength={64}
              autoComplete="off"
              placeholder="Company Max"
              disabled={busy}
              onChange={(event) => setNewLabel(event.target.value)}
            />
            <span id="ae-shared-label-help" className="text-muted-foreground">
              What every account picker shows.
            </span>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            OAuth token
            <Input
              aria-label="OAuth token"
              aria-describedby="ae-shared-token-help"
              type="password"
              value={token}
              autoComplete="new-password"
              placeholder="sk-ant-oat..."
              disabled={busy}
              onChange={(event) => setToken(event.target.value)}
            />
            <span id="ae-shared-token-help" className="text-muted-foreground">
              From `claude setup-token`, signed in to the company account. It never comes back to
              this page.
            </span>
          </label>
          <div className="flex min-w-0 flex-wrap gap-1">
            <Button type="submit" size="sm" disabled={busy}>
              Add shared account
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={closeAdd}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {/* The status region stays mounted so a screen reader announces text put into it. */}
      <p role="status" className="text-xs empty:hidden">
        {messageIsError ? "" : message}
      </p>
      {message && messageIsError && (
        <p role="alert" className="text-xs">
          {message}
        </p>
      )}
    </div>
  );
}
