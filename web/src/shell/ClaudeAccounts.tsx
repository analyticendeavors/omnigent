import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDetectedCredentials, useStoreCredential, type Host } from "@/hooks/useHosts";

/** Host-owned subscription choices; no token is returned by the discovery API. */
export function ClaudeAccounts({ host }: { host: Host | null | undefined }) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState("");
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
          setMessage("Account saved and selected for new chats.");
        },
        onError: (error) => setMessage(error.message),
      },
    );
  };
  if (!host) return null;
  const rows = (accounts.data ?? []).filter((row) => row.family.startsWith("claude-oauth"));
  return (
    <div
      className="flex min-w-0 max-w-full flex-col gap-2 whitespace-normal [overflow-wrap:anywhere] border-t px-3 py-3"
      data-testid="claude-accounts"
    >
      <span className="text-sm font-medium">Claude subscription account</span>
      <p className="text-xs text-muted-foreground">
        Used for new Claude subscription chats on {host.name}, including team members. Start a new
        chat to switch a running conversation. Gateway connections keep their own credentials.
      </p>
      {(accounts.isError || (accounts.isSuccess && rows.length === 0)) && (
        <p role="alert">Could not load Claude accounts. Check the host account configuration.</p>
      )}
      {rows.map((row) => (
        <Button
          type="button"
          key={row.env_var ?? ""}
          variant="ghost"
          size="sm"
          className="h-auto min-h-8 w-full whitespace-normal break-words"
          disabled={store.isPending || row.family === "claude-oauth-active"}
          onClick={() =>
            store.mutate(
              {
                harness: "claude-native",
                kind: "claude-oauth-select",
                account_name: row.env_var ?? "",
              },
              {
                onSuccess: () => setMessage("Account selected for new chats."),
                onError: (error) => setMessage(error.message),
              },
            )
          }
        >
          {row.source}
          {row.family === "claude-oauth-active" ? " (selected)" : ""}
        </Button>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => setAdding(!adding)}>
        Add Claude account
      </Button>
      {adding && (
        <div
          className="flex flex-col gap-2"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              addAccount();
            }
          }}
        >
          <p className="text-xs text-muted-foreground">
            1. Open a terminal on a computer with Claude Code installed. Run:
          </p>
          <code className="block min-w-0 rounded bg-muted p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
            CLAUDE_CONFIG_DIR=~/.claude-backup claude setup-token
          </code>
          <p className="text-xs text-muted-foreground">
            2. In the browser, sign in with your second Claude account's email and login method. If
            your primary account opens, sign out there and choose the second account.
          </p>
          <p className="text-xs text-muted-foreground">
            3. Give this account a label, such as Personal or Backup. Paste the generated OAuth
            token below, not your password. Your original CLI login is preserved. When the token
            expires, add a fresh token under a new name.
          </p>
          <Input
            aria-label="Claude account name"
            placeholder="Label, e.g. Backup"
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
          />
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
      )}
      {message && (
        <p role="status" className="text-xs">
          {message}
        </p>
      )}
    </div>
  );
}
