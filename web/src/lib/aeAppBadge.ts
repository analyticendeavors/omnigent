// The slot count on the installed app's icon (omnigent-ae, 2026-09-24): Reid
// asked for the count everywhere, the phone's home screen included. The Badging
// API (`navigator.setAppBadge`) draws a number on an installed web app's icon;
// Safari supports it for Home Screen apps from iOS 16.4 once notification
// permission is granted (upstream already asks for it on the first tap, for
// its idle notifications), and Chromium desktop installs support it outright.
// Zero clears the badge. Anywhere the API is missing or refuses, nothing
// happens: the sidebar row and the session chip still show the count.

type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** Show `count` on the app icon, or clear it at zero. Never throws. */
export function syncAeAppBadge(
  count: number,
  nav: Navigator | undefined = globalThis.navigator,
): void {
  const badging = nav as BadgingNavigator | undefined;
  if (!badging?.setAppBadge) return;
  const done =
    count > 0 ? badging.setAppBadge(count) : (badging.clearAppBadge?.() ?? badging.setAppBadge(0));
  // Rejected without permission (iOS) or outside an installed app: ignore.
  void Promise.resolve(done).catch(() => undefined);
}
