// GitHub links an extension may open without the host handing them out first.
// omnigent-ae patch P25 (2026-09-27).
//
// Extension pages run in an iframe with `sandbox="allow-scripts"`
// (`ExtensionViewHost.tsx`), so they cannot open a window themselves; they ask
// the host through `navigation.openExternal`, which upstream allows only for a
// URL the host already handed to that extension (`sessions.pullRequest` hands
// out one per session). The AE Dashboard lists pull requests the AE routes
// read from GitHub, not from that call, so its cards could only offer "Copy
// link", and the owner works from an iPhone where copy and paste into Safari is the
// slowest step of a merge. This admits one more kind of URL: a pull request or
// issue page on github.com, written exactly the way GitHub's API returns it.
//
// Why this is safe to open for any extension holding the navigation
// permission: the host opens it in a new browsing context with no opener
// (`noopener,noreferrer` until P27, which clears `opener` itself so a blocked
// tab can be told apart; see `aeOpenExternalWindow`), the scheme is https, the host is exactly github.com (no userinfo,
// no port, so no lookalike authority), the path has a fixed shape with no
// encoded characters, and there is no query string, so the link cannot carry
// parameters to a GitHub endpoint. The worst an extension can do with it is
// open a GitHub pull request or issue page in a new tab.

import { ExtensionHostServiceError } from "@/extensions/services/errors";
import { isNativeShell } from "@/lib/nativeBridge";

const OWNER_OR_REPO = "[A-Za-z0-9._-]{1,100}";
const NUMBER = "[1-9][0-9]{0,9}";
const FRAGMENT = "(?:#[A-Za-z0-9._~-]{1,256})?";

const GITHUB_LINK = new RegExp(
  `^https://github\\.com/(${OWNER_OR_REPO})/(${OWNER_OR_REPO})/` +
    `(?:pull/${NUMBER}(?:/(?:files|commits|checks))?|issues/${NUMBER})${FRAGMENT}$`,
);

/**
 * True for `https://github.com/<owner>/<repo>/pull/<n>` (optionally followed by
 * `/files`, `/commits` or `/checks`) and `https://github.com/<owner>/<repo>/issues/<n>`,
 * each with an optional `#fragment`, and nothing else.
 */
export function isAeGithubLinkUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const match = GITHUB_LINK.exec(url);
  if (!match) return false;
  // A segment of dots is a path step, not a name ("/a/../pull/1").
  if (/^\.+$/.test(match[1]) || /^\.+$/.test(match[2])) return false;
  // The browser must read the string as the same URL, character for character.
  try {
    return new URL(url).href === url;
  } catch {
    return false;
  }
}

// Fabric Admin links (omnigent-ae patch, 2026-10-16). The AE Fabric Admin
// extension page offers "Open in Azure" and "Open in Fabric" for a capacity and
// asks the host to open them, which the allowlist above refused. Exactly two
// shapes are admitted, both https, with no userinfo, port, query or extra path:
// one capacity's overview blade on portal.azure.com (the fragment names the
// resource, so the guid is strict and the resource group and capacity name
// are limited to Azure's name characters), and Fabric's capacity settings page.
const GUID = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";
const AZURE_CAPACITY_LINK = new RegExp(
  `^https://portal\\.azure\\.com/#resource/subscriptions/${GUID}` +
    "/resourceGroups/[A-Za-z0-9._()-]{1,90}" +
    "/providers/Microsoft\\.Fabric/capacities/[A-Za-z0-9-]{1,63}/overview$",
);
const FABRIC_CAPACITIES_LINK = "https://app.fabric.microsoft.com/admin-portal/capacities";

/**
 * True for one Fabric capacity's Azure portal overview link
 * (`https://portal.azure.com/#resource/subscriptions/<guid>/resourceGroups/<rg>/providers/Microsoft.Fabric/capacities/<name>/overview`)
 * and for `https://app.fabric.microsoft.com/admin-portal/capacities`, and nothing else.
 */
export function isAeFabricAdminLinkUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  if (url === FABRIC_CAPACITIES_LINK) return true;
  if (!AZURE_CAPACITY_LINK.test(url)) return false;
  // A segment of dots is a path step, not a name.
  if (/\/resourceGroups\/\.+\//.test(url)) return false;
  // The browser must read the string as the same URL, character for character.
  try {
    return new URL(url).href === url;
  } catch {
    return false;
  }
}

// Databricks links (omnigent-ae patch, 2026-10-19). The Admin Center's
// Databricks section offers "Open in Databricks" for the workspace and for each
// SQL warehouse, which the allowlists above refused, so the page fell back to
// Copy. Exactly two shapes are admitted on any one-label workspace host under
// cloud.databricks.com (Databricks on AWS), both https, with no userinfo, port,
// query or fragment: the workspace's root, with or without its trailing slash
// (the server sends it without), and one warehouse's page, whose id is 16
// lowercase hex characters. A punycode label (xn--) is refused, so a lookalike
// workspace name cannot show in the address bar as Unicode.
const DATABRICKS_WORKSPACE =
  "https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.cloud\\.databricks\\.com";
const DATABRICKS_LINK = new RegExp(`^${DATABRICKS_WORKSPACE}(?:/|/sql/warehouses/[0-9a-f]{16})?$`);

/**
 * True for `https://<workspace>.cloud.databricks.com` (with or without a
 * trailing slash) and `https://<workspace>.cloud.databricks.com/sql/warehouses/<id>`,
 * and nothing else.
 */
export function isAeDatabricksLinkUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  if (!DATABRICKS_LINK.test(url) || url.startsWith("https://xn--")) return false;
  // The browser must read the string as the same URL, character for character
  // (the bare workspace root reads back with its slash).
  try {
    const href = new URL(url).href;
    return href === url || href === `${url}/`;
  } catch {
    return false;
  }
}

// Azure cost link (omnigent-ae patch, 2026-10-22). The Admin Center's Azure
// spend card offers "Open Cost Management" for the full cost analysis in the
// Azure portal, which the allowlists above refused. Exactly one URL is
// admitted, compared as a whole string: it names no subscription, so the link
// reveals nothing and the portal asks the signed-in user which scope to show.
const AZURE_COST_LINK =
  "https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis";

/** True for the Azure portal's cost analysis page, `AZURE_COST_LINK`, and nothing else. */
export function isAeAzureCostLinkUrl(url: unknown): url is string {
  return url === AZURE_COST_LINK;
}

/** The error code `navigation.openExternal` rejects with when no tab opened. */
export const AE_POPUP_BLOCKED = "PopupBlocked";

/**
 * Open *url* in a new tab for `navigation.openExternal`, and throw when the
 * browser blocked it (patch P27, 2026-09-27). Upstream opened with
 * `noopener,noreferrer`, which makes `window.open` return null even on
 * success, so a tab that iOS Safari blocked (the open runs one MessagePort
 * hop after the tap) looked like success and the extension never offered its
 * fallback. Now the tab opens without `noopener`, and its `opener` is cleared
 * at once, which keeps noopener's protection; a null window means blocked.
 * Native shells keep upstream's call: their window-open policy routes the
 * link to the system browser and reports null regardless (see
 * `followLinkWithPopupFallback` in ChatMarkdown.tsx).
 */
export function aeOpenExternalWindow(url: string): void {
  if (isNativeShell()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const opened = window.open(url, "_blank");
  if (!opened) {
    throw new ExtensionHostServiceError(
      AE_POPUP_BLOCKED,
      "The browser blocked the new tab; allow pop-ups for this site or copy the link",
    );
  }
  opened.opener = null;
}
