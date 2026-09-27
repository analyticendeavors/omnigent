// GitHub links an extension may open without the host handing them out first.
// omnigent-ae patch P25 (2026-09-27).
//
// Extension pages run in an iframe with `sandbox="allow-scripts"`
// (`ExtensionViewHost.tsx`), so they cannot open a window themselves; they ask
// the host through `navigation.openExternal`, which upstream allows only for a
// URL the host already handed to that extension (`sessions.pullRequest` hands
// out one per session). The AE Dashboard lists pull requests the AE routes
// read from GitHub, not from that call, so its cards could only offer "Copy
// link", and Reid works from an iPhone where copy and paste into Safari is the
// slowest step of a merge. This admits one more kind of URL: a pull request or
// issue page on github.com, written exactly the way GitHub's API returns it.
//
// Why this is safe to open for any extension holding the navigation
// permission: the host opens it with `noopener,noreferrer` in a new browsing
// context, the scheme is https, the host is exactly github.com (no userinfo,
// no port, so no lookalike authority), the path has a fixed shape with no
// encoded characters, and there is no query string, so the link cannot carry
// parameters to a GitHub endpoint. The worst an extension can do with it is
// open a GitHub pull request or issue page in a new tab.

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
