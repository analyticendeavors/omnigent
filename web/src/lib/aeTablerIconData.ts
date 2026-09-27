// The Tabler icon set behind project icons (omnigent-ae, 2026-09-24). Two lazy
// JSON files from `@tabler/icons`, never in the main bundle: the outline shapes
// of every icon (about 240 KB gzipped, fetched the first time a `tabler:` icon
// renders or the picker opens) and the search tags (about 200 KB gzipped,
// fetched by the picker only). Both files sit outside the package's `exports`
// map, so they are reached with a glob on the installed path; that also keeps
// tsc from typing two megabytes of JSON.
//
// Fetched as JSON assets rather than `import()`ed chunks (2026-09-27): Safari
// caches a failed dynamic import, so retrying the same `import()` never
// succeeds there. The eager `?url` glob bundles only each file's URL (relative
// to `import.meta.url`, so any base path works); a retry adds `retry=N`, which
// the static server ignores and every cache treats as a new URL.

/** One outline icon: its `<path>` elements and their attributes. */
export type AeTablerIconNode = [tag: string, attrs: Record<string, string>][];
export type AeTablerIconSet = Record<string, AeTablerIconNode>;
/** Icon name to its category and tags, from the package's `icons.json`. */
export type AeTablerIconTags = Record<string, { category?: string; tags?: (string | number)[] }>;

const nodeFiles = import.meta.glob<string>(
  "/node_modules/@tabler/icons/tabler-nodes-outline.json",
  {
    query: "?url",
    import: "default",
    eager: true,
  },
);
const tagFiles = import.meta.glob<string>("/node_modules/@tabler/icons/icons.json", {
  query: "?url",
  import: "default",
  eager: true,
});

async function loadOne<T>(files: Record<string, string>, what: string, retry: number): Promise<T> {
  const url = Object.values(files)[0];
  if (!url) {
    throw new Error(`@tabler/icons ${what} is missing; run pnpm install in web/ and rebuild`);
  }
  const target = retry > 0 ? `${url}${url.includes("?") ? "&" : "?"}retry=${retry}` : url;
  // A static asset of this bundle, not a server API route: the host transport
  // (authenticatedFetch) is for API paths, so a plain fetch is the right call.
  // oxlint-disable-next-line no-restricted-globals
  const response = await fetch(target);
  if (!response.ok) {
    throw new Error(`@tabler/icons ${what} failed to load (HTTP ${response.status}); try again`);
  }
  return (await response.json()) as T;
}

let iconSet: AeTablerIconSet | null = null;
let iconSetPromise: Promise<AeTablerIconSet> | null = null;
let iconTagsPromise: Promise<AeTablerIconTags> | null = null;
let iconSetFailures = 0;
let iconTagsFailures = 0;
const iconSetListeners = new Set<(set: AeTablerIconSet) => void>();

/** The loaded set, or `null` until `loadAeTablerIcons` has resolved once. */
export function aeTablerIconsIfLoaded(): AeTablerIconSet | null {
  return iconSet;
}

/**
 * Call `listener` when the outline set loads, whoever asked for it, so an icon
 * that saw a failed load draws itself once a later retry succeeds. Returns the
 * unsubscribe.
 */
export function subscribeAeTablerIcons(listener: (set: AeTablerIconSet) => void): () => void {
  iconSetListeners.add(listener);
  return () => {
    iconSetListeners.delete(listener);
  };
}

/** Fetch the outline set once; after a failure the next call fetches again under a new URL. */
export function loadAeTablerIcons(): Promise<AeTablerIconSet> {
  iconSetPromise ??= loadOne<AeTablerIconSet>(
    nodeFiles,
    "tabler-nodes-outline.json",
    iconSetFailures,
  ).then(
    (set) => {
      iconSet = set;
      for (const listener of [...iconSetListeners]) listener(set);
      return set;
    },
    (err: unknown) => {
      iconSetPromise = null;
      iconSetFailures += 1;
      throw err;
    },
  );
  return iconSetPromise;
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
