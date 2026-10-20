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
const USERS_GROUP: AeTablerIconNode = [
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
      <AeTablerSvg node={USERS_GROUP} className="size-3" />
      Shared
    </span>
  );
}
