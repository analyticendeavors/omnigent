// The Tabler icon set behind project icons (omnigent-ae, 2026-09-24). Two lazy
// chunks from `@tabler/icons`, never in the main bundle: the outline shapes of
// every icon (about 240 KB gzipped, fetched the first time a `tabler:` icon
// renders or the picker opens) and the search tags (about 200 KB gzipped,
// fetched by the picker only). Both files sit outside the package's `exports`
// map, so they are reached with a glob on the installed path; that also keeps
// tsc from typing two megabytes of JSON.

/** One outline icon: its `<path>` elements and their attributes. */
export type AeTablerIconNode = [tag: string, attrs: Record<string, string>][];
export type AeTablerIconSet = Record<string, AeTablerIconNode>;
/** Icon name to its category and tags, from the package's `icons.json`. */
export type AeTablerIconTags = Record<string, { category?: string; tags?: (string | number)[] }>;

const nodeFiles = import.meta.glob<AeTablerIconSet>(
  "/node_modules/@tabler/icons/tabler-nodes-outline.json",
  { import: "default" },
);
const tagFiles = import.meta.glob<AeTablerIconTags>("/node_modules/@tabler/icons/icons.json", {
  import: "default",
});

function loadOne<T>(files: Record<string, () => Promise<T>>, what: string): Promise<T> {
  const load = Object.values(files)[0];
  if (!load) {
    return Promise.reject(
      new Error(`@tabler/icons ${what} is missing; run pnpm install in web/ and rebuild`),
    );
  }
  return load();
}

let iconSet: AeTablerIconSet | null = null;
let iconSetPromise: Promise<AeTablerIconSet> | null = null;
let iconTagsPromise: Promise<AeTablerIconTags> | null = null;

/** The loaded set, or `null` until `loadAeTablerIcons` has resolved once. */
export function aeTablerIconsIfLoaded(): AeTablerIconSet | null {
  return iconSet;
}

/** Fetch the outline set once; a failed fetch is retried on the next call. */
export function loadAeTablerIcons(): Promise<AeTablerIconSet> {
  iconSetPromise ??= loadOne(nodeFiles, "tabler-nodes-outline.json").then(
    (set) => {
      iconSet = set;
      return set;
    },
    (err: unknown) => {
      iconSetPromise = null;
      throw err;
    },
  );
  return iconSetPromise;
}

/** Fetch the search tags once; a failed fetch is retried on the next call. */
export function loadAeTablerIconTags(): Promise<AeTablerIconTags> {
  iconTagsPromise ??= loadOne(tagFiles, "icons.json").catch((err: unknown) => {
    iconTagsPromise = null;
    throw err;
  });
  return iconTagsPromise;
}
