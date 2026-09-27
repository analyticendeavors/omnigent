// Test stand-in for `aeTablerAssetFetch` (omnigent-ae, 2026-09-27), installed
// for every suite by `src/test-setup.ts`: it answers from the installed
// `@tabler/icons` files on disk, so icons draw as they would in the app and no
// suite's fetch stub or call count sees the icon set.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

/** The file behind an asset URL Vite gives the tests (`/@fs/<abs>` or root-relative). */
export function aeTablerAssetFile(url: string): string {
  const path = url.split("?")[0];
  if (path.startsWith("/@fs/")) return path.slice("/@fs".length);
  return resolve(dirname(fileURLToPath(import.meta.url)), `../..${path}`);
}

export const fetchAeTablerAsset = vi.fn(
  async (url: string) => new Response(await readFile(aeTablerAssetFile(url))),
);
