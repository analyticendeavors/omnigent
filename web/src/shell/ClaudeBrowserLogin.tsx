import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStoreCredential, type StoreCredentialResult } from "@/hooks/useHosts";

function safeLoginUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["claude.com", "claude.ai"].includes(url.hostname) &&
      ["/oauth/authorize", "/cai/oauth/authorize"].includes(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Only the provider's authorization link and one-time code reach this form. */
export function ClaudeBrowserLogin({
  hostId,
  name,
  onComplete,
}: {
  hostId: string;
  name: string;
  onComplete: () => void;
}) {
  const store = useStoreCredential(hostId);
  const [login, setLogin] = useState<StoreCredentialResult | null>(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const completed = useRef(false);
  const done = useRef(onComplete);
  done.current = onComplete;
  const active =
    login?.login_status === "starting" ||
    login?.login_status === "waiting" ||
    login?.login_status === "exchanging";
  const action = async (
    kind: "claude-login-start" | "claude-login-code" | "claude-login-cancel",
  ) => {
    if (store.isPending) return;
    setError("");
    try {
      const result = await store.mutateAsync({
        harness: "claude-native",
        kind,
        account_name: kind === "claude-login-start" ? name.trim() : (login?.login_id ?? ""),
        ...(kind === "claude-login-code" ? { secret: code.trim() } : {}),
      });
      setCode("");
      setLogin(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start sign-in.");
    }
  };
  const request = store.mutateAsync;
  useEffect(() => {
    if (!active || !login?.login_id) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void request({
        harness: "claude-native",
        kind: "claude-login-poll",
        account_name: login.login_id ?? "",
      })
        .then((result) => {
          if (!cancelled) setLogin(result);
        })
        .catch((cause) => {
          if (!cancelled) {
            setError(
              cause instanceof Error ? cause.message : "Connection lost. Start sign-in again.",
            );
            setLogin(null);
          }
        });
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, login, request]);
  useEffect(() => {
    if (login?.login_status === "complete" && !completed.current) {
      completed.current = true;
      done.current();
    }
  }, [login]);
  const url = safeLoginUrl(login?.login_url);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {!active && (
        <Button
          type="button"
          disabled={!name.trim() || store.isPending}
          onClick={() => void action("claude-login-start")}
        >
          Sign in with Claude
        </Button>
      )}
      {active && (
        <>
          <p role="status" className="text-xs text-muted-foreground">
            {login?.login_status === "exchanging"
              ? "Completing sign-in with Claude…"
              : url
                ? "Open Claude and authorize your second subscription account. Your password stays on Claude's site."
                : "Preparing secure sign-in on the host…"}
          </p>
          {url && (
            <a className="text-sm underline" href={url} target="_blank" rel="noopener noreferrer">
              Open Claude sign-in
            </a>
          )}
          {url && (
            <>
              <p className="text-xs text-muted-foreground">
                Paste the full authorization code from Claude here, even if it is long. If it opens
                your primary account, switch to the second account before authorizing.
              </p>
              <Input
                aria-label="Claude authorization code"
                placeholder="Authorization code (paste the full code)"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button
                type="button"
                disabled={!code.trim() || store.isPending || login?.login_status === "exchanging"}
                onClick={() => void action("claude-login-code")}
              >
                Complete sign-in
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={store.isPending}
            onClick={() => void action("claude-login-cancel")}
          >
            Cancel sign-in
          </Button>
        </>
      )}
      {(error || login?.login_error) && (
        <p role="alert" className="text-xs text-destructive">
          {error || login?.login_error}
        </p>
      )}
    </div>
  );
}
