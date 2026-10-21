import { AeClaudeAccountRemoveButton, AeClaudeAccountRemoveConfirm } from "./AeClaudeAccountRemove";
import { AeSharedClaudeAccountsGroup } from "./AeSharedClaudeAccountsGroup";
import { ClaudeBrowserLogin } from "./ClaudeBrowserLogin";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDetectedCredentials, useStoreCredential, type Host } from "@/hooks/useHosts";
import { AeSharedAccountMarker, aeIsSharedAccount } from "@/lib/aeSharedClaudeAccounts";

/** Host-owned subscription choices; no token is returned by the discovery API. */
export function ClaudeAccounts({
  host,
  compact = false,
}: {
  host: Host | null | undefined;
  compact?: boolean;
}) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [accountLabel, setAccountLabel] = useState("");
  const accounts = useDetectedCredentials(host?.host_id, !!host);
  const store = useStoreCredential(host?.host_id ?? "");
  const addAccount = () => {
    if (store.isPending || !name.trim() || !token.trim()) return;
    store.mutate(
      {
        harness: "claude-native",
        kind: "claude-oauth-add",
        account_name: name.trim(),
        secret: token.trim(),
      },
      {
        onSuccess: () => {
          setToken("");
          setName("");
          setAdding(false);
          setMessageIsError(false);
          setMessage("Account saved and selected for new chats.");
        },
        onError: (error) => {
          setMessageIsError(true);
          setMessage(error.message);
        },
      },
    );
  };
  if (!host) return null;
  const rows = (accounts.data ?? []).filter((row) => row.family.startsWith("claude-oauth"));
  return (
    <div
      className={
        compact
          ? "flex min-w-0 max-w-full flex-col gap-2"
          : "flex min-w-0 max-w-full flex-col gap-2 whitespace-normal [overflow-wrap:anywhere] border-t px-3 py-3"
      }
      data-testid="claude-accounts"
    >
      {!compact && (
        <>
          <span className="text-sm font-medium">Claude subscription account</span>
          <p className="text-xs text-muted-foreground">
            Used for new Claude subscription chats on {host.name}, including team members. Start a
            new chat to switch a running conversation. Gateway connections keep their own
            credentials.
          </p>
        </>
      )}
      {(accounts.isError || (accounts.isSuccess && rows.length === 0)) && (
        <p role="alert">Could not load Claude accounts. Check the host account configuration.</p>
      )}
      <div className={compact ? "grid min-w-0 grid-cols-2 gap-1" : "flex min-w-0 flex-wrap gap-2"}>
        {rows.map((row) => {
          const accountId = row.env_var ?? "";
          const displayLabel = row.source;
          const shared = aeIsSharedAccount(accountId);
          if (shared && !compact) return null; // The Shared group lists these.
          return (
            <div
              key={accountId}
              className={
                compact
                  ? "min-w-0"
                  : "flex min-w-[10rem] flex-[1_1_10rem] flex-col gap-1 rounded border p-2"
              }
            >
              <div className={compact ? "min-w-0" : "flex min-w-0 flex-wrap items-center gap-1"}>
                <Button
                  type="button"
                  variant={compact && row.family === "claude-oauth-active" ? "secondary" : "ghost"}
                  size="sm"
                  className={
                    compact
                      ? "h-8 w-full min-w-0 justify-start overflow-hidden text-ellipsis whitespace-nowrap px-2"
                      : "h-auto min-h-8 min-w-0 flex-1 whitespace-normal break-words"
                  }
                  aria-pressed={compact ? row.family === "claude-oauth-active" : undefined}
                  title={
                    compact
                      ? `${displayLabel}: ${row.family === "claude-oauth-active" ? "current" : "select as"} new-chat default`
                      : undefined
                  }
                  disabled={store.isPending || row.family === "claude-oauth-active"}
                  onClick={() =>
                    store.mutate(
                      {
                        harness: "claude-native",
                        kind: "claude-oauth-select",
                        account_name: accountId,
                      },
                      {
                        onSuccess: () => {
                          setMessageIsError(false);
                          setMessage("Account selected for new chats.");
                        },
                        onError: (error) => {
                          setMessageIsError(true);
                          setMessage(error.message);
                        },
                      },
                    )
                  }
                >
                  {displayLabel}
                  {shared && <AeSharedAccountMarker />}
                  {row.family === "claude-oauth-active" ? " (selected)" : ""}
                </Button>
                {!compact && !shared && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Rename ${displayLabel}`}
                    disabled={store.isPending}
                    onClick={() => {
                      setEditingId(accountId);
                      setRemovingId(null);
                      setAccountLabel(displayLabel);
                      setMessage("");
                    }}
                  >
                    Rename
                  </Button>
                )}
                {!compact && !shared && accountId && (
                  <AeClaudeAccountRemoveButton
                    label={displayLabel}
                    disabled={store.isPending}
                    onClick={() => {
                      setRemovingId(accountId);
                      setEditingId(null);
                      setMessage("");
                    }}
                  />
                )}
              </div>
              {!compact && removingId === accountId && (
                <AeClaudeAccountRemoveConfirm
                  hostName={host.name}
                  accountId={accountId}
                  label={displayLabel}
                  selected={row.family === "claude-oauth-active"}
                  store={store}
                  onDone={() => {
                    setRemovingId(null);
                    setMessageIsError(false);
                    setMessage("Account removed.");
                  }}
                  onFail={(error) => {
                    setMessageIsError(true);
                    setMessage(error.message);
                  }}
                  onCancel={() => setRemovingId(null)}
                />
              )}
              {!compact && editingId === accountId && (
                <div className="flex min-w-0 flex-wrap gap-1">
                  <Input
                    aria-label={`Account label for ${displayLabel}`}
                    className="min-w-0 flex-1"
                    value={accountLabel}
                    maxLength={64}
                    disabled={store.isPending}
                    onChange={(event) => setAccountLabel(event.target.value)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={store.isPending || !accountLabel.trim()}
                    onClick={() =>
                      store.mutate(
                        {
                          harness: "claude-native",
                          kind: "claude-oauth-rename",
                          account_name: accountId,
                          account_label: accountLabel.trim(),
                        },
                        {
                          onSuccess: () => {
                            setEditingId(null);
                            setMessageIsError(false);
                            setMessage("Account name saved.");
                          },
                          onError: (error) => {
                            setMessageIsError(true);
                            setMessage(error.message);
                          },
                        },
                      )
                    }
                  >
                    Save name
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={store.isPending}
                    onClick={() => {
                      setEditingId(null);
                      setMessage("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!compact && (
        <Button type="button" variant="outline" size="sm" onClick={() => setAdding(!adding)}>
          Add Claude account
        </Button>
      )}
      {!compact && adding && (
        <div className="flex min-w-0 flex-col gap-2">
          <Input
            aria-label="Claude account name"
            placeholder="Account label, e.g. Backup"
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
          />
          <ClaudeBrowserLogin
            hostId={host.host_id}
            name={name}
            onComplete={() => {
              setName("");
              setToken("");
              setAdding(false);
              setMessageIsError(false);
              setMessage("Account saved and selected for new chats.");
            }}
          />
          <details className="min-w-0">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Advanced: paste an existing OAuth token
            </summary>
            <div className="mt-2 flex min-w-0 flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                1. Open a terminal on a computer with Claude Code installed. Run:
              </p>
              <code className="block min-w-0 rounded bg-muted p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                CLAUDE_CONFIG_DIR=~/.claude-backup claude setup-token
              </code>
              <p className="text-xs text-muted-foreground">
                2. In the browser, sign in with your second Claude account's email and login method.
                If your primary account opens, sign out there and choose the second account.
              </p>
              <p className="text-xs text-muted-foreground">
                3. Give this account a label, such as Personal or Backup. Paste the generated OAuth
                token below, not your password. Your original CLI login is preserved. When the token
                expires, add a fresh token under a new name.
              </p>
              <Input
                aria-label="Claude OAuth token"
                placeholder="OAuth token from setup-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <Button
                type="button"
                onClick={addAccount}
                size="sm"
                disabled={store.isPending || !name.trim() || !token.trim()}
              >
                Save account
              </Button>
            </div>
          </details>
        </div>
      )}
      {message && (
        <p role={messageIsError ? "alert" : "status"} className="text-xs">
          {message}
        </p>
      )}
      {!compact && (
        <AeSharedClaudeAccountsGroup
          hostId={host.host_id}
          rows={rows}
          onChanged={accounts.refetch}
        />
      )}
    </div>
  );
}
