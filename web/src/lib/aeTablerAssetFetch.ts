// The one network call behind the Tabler icon set (omnigent-ae, 2026-09-27),
// in its own module so the test setup can serve the files from disk and no
// suite that draws a `tabler:` icon reaches the global fetch.

/**
 * Fetch one of this bundle's static assets. A plain fetch: the host transport
 * (authenticatedFetch) is for server API routes, and these files sit next to
 * the page's own scripts.
 */
export function fetchAeTablerAsset(url: string): Promise<Response> {
  // oxlint-disable-next-line no-restricted-globals
  return fetch(url);
}
