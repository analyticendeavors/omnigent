// Shared Claude accounts (omnigent-ae): subscription logins the server's admin
// keeps for every user. A host lists its own logins; the server lists the
// shared ones (GET /v1/ae/claude-accounts/shared, names and labels only), and
// the picker shows both, the shared ones marked. A shared account's id is
// `shared:<name>`, which no host login can be (host names have no colon).

import type { DetectedCredential } from "@/hooks/useHosts";
import { authenticatedFetch } from "@/lib/identity";
import { AeTablerSvg } from "@/lib/aeTablerIcon";
import type { AeTablerIconNode } from "@/lib/aeTablerIconData";

export const AE_SHARED_ACCOUNT_PREFIX = "shared:";
const SHARED_ACCOUNTS_PATH = "/v1/ae/claude-accounts/shared";

export interface AeSharedClaudeAccount {
  name: string;
  /** The id a host selects and a fork sends: `shared:<name>`. */
  account: string;
  label: string;
}

/** Whether an account id names a shared account. */
export function aeIsSharedAccount(account: string | null | undefined): boolean {
  return typeof account === "string" && account.startsWith(AE_SHARED_ACCOUNT_PREFIX);
}

/** The server's shared accounts; empty when the server has none or does not offer them. */
export async function aeFetchSharedClaudeAccounts(): Promise<AeSharedClaudeAccount[]> {
  try {
    const res = await authenticatedFetch(SHARED_ACCOUNTS_PATH);
    if (!res.ok) return [];
    const body = (await res.json()) as { accounts?: unknown };
    if (!Array.isArray(body.accounts)) return [];
    return body.accounts.filter(
      (row): row is AeSharedClaudeAccount =>
        !!row &&
        typeof row === "object" &&
        typeof (row as AeSharedClaudeAccount).name === "string" &&
        aeIsSharedAccount((row as AeSharedClaudeAccount).account) &&
        typeof (row as AeSharedClaudeAccount).label === "string",
    );
  } catch {
    return [];
  }
}

// Settings manages the pool (2026-10-20): the full list with who added each
// account, and the admin's add, relabel and remove. The server checks admin on
// every change; the token goes in once and never comes back.

/** One shared account as the full list reads it. */
export interface AeSharedClaudeAccountDetail extends AeSharedClaudeAccount {
  created_by: string;
  created_at: string;
}

export interface AeSharedClaudeAccountList {
  accounts: AeSharedClaudeAccountDetail[];
  /** Whether the caller is an admin, who may add, relabel and remove. */
  can_manage: boolean;
  /** Whether the server has AE_SHARED_ACCOUNTS_KEY. */
  key_configured: boolean;
}

export interface AeSharedClaudeAccountInput {
  name: string;
  label?: string;
  token: string;
}

const sharedAccountPath = (name: string, action: string) =>
  `${SHARED_ACCOUNTS_PATH}/${encodeURIComponent(name)}/${action}`;

/** One call to the shared accounts routes; a refusal throws the server's own message. */
async function aeSharedRequest<T>(path: string, body?: unknown): Promise<T> {
  const res = await authenticatedFetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  let answer: unknown = null;
  try {
    answer = await res.json();
  } catch {
    // A body that is not JSON keeps the status line below.
  }
  if (!res.ok) {
    const message = (answer as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(
      typeof message === "string" && message ? message : `Request failed (${res.status})`,
    );
  }
  return answer as T;
}

/** The full list for Settings; throws when the server cannot answer it. */
export async function aeReadSharedClaudeAccounts(): Promise<AeSharedClaudeAccountList> {
  const answer = await aeSharedRequest<Partial<AeSharedClaudeAccountList> | null>(
    SHARED_ACCOUNTS_PATH,
  );
  return {
    accounts: Array.isArray(answer?.accounts) ? answer.accounts : [],
    can_manage: answer?.can_manage === true,
    key_configured: answer?.key_configured !== false,
  };
}

export const aeAddSharedClaudeAccount = (input: AeSharedClaudeAccountInput) =>
  aeSharedRequest<unknown>(SHARED_ACCOUNTS_PATH, input);

export const aeRelabelSharedClaudeAccount = (name: string, label: string) =>
  aeSharedRequest<unknown>(sharedAccountPath(name, "label"), { label });

export const aeRemoveSharedClaudeAccount = (name: string) =>
  aeSharedRequest<unknown>(sharedAccountPath(name, "delete"), {});

/**
 * The host's rows with the shared accounts after its own logins. A host that
 * reports no Claude login rows gets none added (its accounts failed to load).
 * The host reports a selected shared account by id only; the server's label
 * replaces it, and a selection the server no longer lists keeps the host's row.
 */
export function aeMergeSharedClaudeAccounts(
  rows: readonly DetectedCredential[],
  shared: readonly AeSharedClaudeAccount[],
): DetectedCredential[] {
  if (!rows.some((row) => row.family.startsWith("claude-oauth"))) return [...rows];
  const listed = new Set(shared.map((account) => account.account));
  const active = new Set(
    rows
      .filter((row) => row.family === "claude-oauth-active" && aeIsSharedAccount(row.env_var))
      .map((row) => row.env_var),
  );
  const kept = rows.filter(
    (row) => !(row.family.startsWith("claude-oauth") && listed.has(row.env_var ?? "")),
  );
  return [
    ...kept,
    ...shared.map((account) => ({
      family: active.has(account.account) ? "claude-oauth-active" : "claude-oauth",
      source: account.label,
      env_var: account.account,
    })),
  ];
}

/** Tabler `users-group` (outline, @tabler/icons 3.46.0), inlined. */
export const AE_USERS_GROUP_ICON: AeTablerIconNode = [
  ["path", { d: "M10 13a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" }],
  ["path", { d: "M8 21v-1a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v1" }],
  ["path", { d: "M15 5a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" }],
  ["path", { d: "M17 10h2a2 2 0 0 1 2 2v1" }],
  ["path", { d: "M5 5a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" }],
  ["path", { d: "M3 13v-1a2 2 0 0 1 2 -2h2" }],
];

/** The visible "Shared" marker beside a shared account's label. */
export function AeSharedAccountMarker() {
  return (
    <span
      className="ml-1 inline-flex shrink-0 items-center gap-0.5 rounded border px-1 text-[10px] font-medium text-muted-foreground"
      data-testid="ae-shared-account-marker"
    >
      <AeTablerSvg node={AE_USERS_GROUP_ICON} className="size-3" />
      Shared
    </span>
  );
}
