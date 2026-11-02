// The Claude account a scheduled task is pinned to. Shared by the automation
// dialog and its account field; kept out of both component files so a test that
// mocks one component module never drops these exports.

/** Select value for "no pin": runs follow the host's active Claude account. */
export const FOLLOW_ACTIVE_ACCOUNT = "__follow_active_account__";
/** Select value for the default CLI login, which the wire names with "". */
export const DEFAULT_LOGIN_ACCOUNT = "__default_login__";

/** The picker's value for a task's stored pin (`null` or `undefined` is no pin). */
export function accountChoiceFor(account: string | null | undefined): string {
  if (account === null || account === undefined) return FOLLOW_ACTIVE_ACCOUNT;
  return account === "" ? DEFAULT_LOGIN_ACCOUNT : account;
}

/**
 * The `claudeAccount` key to send for *choice*. A new task with no pin omits
 * it; an edit sends it only when the pick changed from *original* (`undefined`
 * on create). `null` clears the pin and `""` pins the default login.
 */
export function claudeAccountInput(
  choice: string,
  original: string | null | undefined,
  isEdit: boolean,
): { claudeAccount?: string | null } {
  const next =
    choice === FOLLOW_ACTIVE_ACCOUNT ? null : choice === DEFAULT_LOGIN_ACCOUNT ? "" : choice;
  if (next === (original ?? null)) return {};
  if (!isEdit && next === null) return {};
  return { claudeAccount: next };
}
