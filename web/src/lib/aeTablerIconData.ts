// The Tabler icon set behind project icons (omnigent-ae, 2026-09-24). Two lazy
// JSON files from `@tabler/icons`, never in the main bundle: the outline shapes
// of every icon (about 250 KB gzipped, fetched the first time a `tabler:` icon
// renders or the picker opens) and the search tags (about 200 KB gzipped,
// fetched by the picker only). Both files sit outside the package's `exports`
// map, so they are reached with a glob on the installed path; that also keeps
// tsc from typing two megabytes of JSON.
//
// Fetched as JSON assets rather than `import()`ed chunks (2026-09-27): Safari
// caches a failed dynamic import, so retrying the same `import()` never
// succeeds there. The eager `?url` glob bundles only each file's URL (relative
// to `import.meta.url`, so any base path works), and `no-inline` keeps the
// files out of the bundle even in library builds (the embed), where Vite would
// otherwise inline every asset as a data: URL. A retry adds `retry=N` to an
// http(s) URL, which the static server ignores and every cache treats as new.

import { fetchAeTablerAsset } from "@/lib/aeTablerAssetFetch";

/** One outline icon: its `<path>` elements and their attributes. */
export type AeTablerIconNode = [tag: string, attrs: Record<string, string>][];
export type AeTablerIconSet = Record<string, AeTablerIconNode>;
/** Icon name to its category and tags, from the package's `icons.json`. */
export type AeTablerIconTags = Record<string, { category?: string; tags?: (string | number)[] }>;
/** The outline set; `null` while none has loaded and none has failed (or one is loading). */
export type AeTablerIconsState = AeTablerIconSet | "error" | null;

const nodeFiles = import.meta.glob<string>(
  "/node_modules/@tabler/icons/tabler-nodes-outline.json",
  { query: "?url&no-inline", import: "default", eager: true },
);
const tagFiles = import.meta.glob<string>("/node_modules/@tabler/icons/icons.json", {
  query: "?url&no-inline",
  import: "default",
  eager: true,
});

/** The URL for attempt `retry` (0 is the first): a data: or blob: URL never takes a query. */
export function aeTablerRetryUrl(url: string, retry: number): string {
  if (retry === 0 || /^(data|blob):/i.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}retry=${retry}`;
}

async function loadOne<T>(files: Record<string, string>, what: string, retry: number): Promise<T> {
  const url = Object.values(files)[0];
  if (!url) {
    throw new Error(`@tabler/icons ${what} is missing; run pnpm install in web/ and rebuild`);
  }
  const response = await fetchAeTablerAsset(aeTablerRetryUrl(url, retry));
  if (!response.ok) {
    throw new Error(`@tabler/icons ${what} failed to load (HTTP ${response.status}); try again`);
  }
  return (await response.json()) as T;
}

/** Retry delay after `failures` failed loads: 2 s, 4 s, 8 s, then 30 s at most. */
const backoffMs = (failures: number) => Math.min(30_000, 1000 * 2 ** failures);

let iconSet: AeTablerIconSet | null = null;
let iconSetPromise: Promise<AeTablerIconSet> | null = null;
let iconTagsPromise: Promise<AeTablerIconTags> | null = null;
let iconSetFailures = 0;
let iconSetFailedAt = 0;
let iconTagsFailures = 0;
const iconSetListeners = new Set<() => void>();

function notify(): void {
  // Outside the load's promise chain, and one listener's throw cannot stop the
  // rest or leave the load looking failed.
  for (const listener of [...iconSetListeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[tabler icons] a listener threw", err);
    }
  }
}

/** The loaded set, or `null` until `loadAeTablerIcons` has resolved once. */
export function aeTablerIconsIfLoaded(): AeTablerIconSet | null {
  return iconSet;
}

/** The store's snapshot: the set, `"error"` after a failed load until the next attempt, else `null`. */
export function aeTablerIconsState(): AeTablerIconsState {
  if (iconSet) return iconSet;
  return iconSetFailures > 0 && !iconSetPromise ? "error" : null;
}

/**
 * Subscribe to changes of `aeTablerIconsState`, and ask for the set: the first
 * subscriber starts the load, and one arriving after a failure retries once
 * the backoff has passed. Returns the unsubscribe.
 */
export function subscribeAeTablerIcons(listener: () => void): () => void {
  iconSetListeners.add(listener);
  if (!iconSet && !iconSetPromise) {
    if (iconSetFailures === 0 || Date.now() - iconSetFailedAt >= backoffMs(iconSetFailures)) {
      loadAeTablerIcons().catch(() => undefined);
    }
  }
  return () => {
    iconSetListeners.delete(listener);
  };
}

/** Fetch the outline set once; after a failure the next call fetches again under a new URL. */
export function loadAeTablerIcons(): Promise<AeTablerIconSet> {
  if (iconSetPromise) return iconSetPromise;
  const attempt = loadOne<AeTablerIconSet>(nodeFiles, "tabler-nodes-outline.json", iconSetFailures);
  iconSetPromise = attempt.then(
    (set) => {
      iconSet = set;
      return set;
    },
    (err: unknown) => {
      iconSetPromise = null;
      iconSetFailures += 1;
      iconSetFailedAt = Date.now();
      throw err;
    },
  );
  iconSetPromise.then(notify, notify);
  notify();
  return iconSetPromise;
}

// Back online after a failed load: try again for the icons on screen.
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    if (!iconSet && !iconSetPromise && iconSetFailures > 0 && iconSetListeners.size > 0) {
      loadAeTablerIcons().catch(() => undefined);
    }
  });
}

/** Fetch the search tags once; after a failure the next call fetches again under a new URL. */
export function loadAeTablerIconTags(): Promise<AeTablerIconTags> {
  iconTagsPromise ??= loadOne<AeTablerIconTags>(tagFiles, "icons.json", iconTagsFailures).catch(
    (err: unknown) => {
      iconTagsPromise = null;
      iconTagsFailures += 1;
      throw err;
    },
  );
  return iconTagsPromise;
}
