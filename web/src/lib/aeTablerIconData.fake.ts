// A stand-in for `aeTablerIconData` in component suites (omnigent-ae,
// 2026-09-27): the same store contract (subscribing starts the load, a failed
// load reads "error" until one succeeds) with a small set, and a switch that
// makes loads fail.

import type { AeTablerIconSet, AeTablerIconTags, AeTablerIconsState } from "@/lib/aeTablerIconData";

export function createFakeAeTablerIconData(set: AeTablerIconSet, tags: AeTablerIconTags = {}) {
  const store = { state: null as AeTablerIconsState, failing: false, loads: 0 };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const loadAeTablerIcons = () => {
    store.loads += 1;
    store.state = store.failing ? "error" : set;
    notify();
    return store.failing ? Promise.reject(new Error("offline")) : Promise.resolve(set);
  };
  const module = {
    aeTablerIconsIfLoaded: () => (store.state && store.state !== "error" ? store.state : null),
    aeTablerIconsState: () => store.state,
    subscribeAeTablerIcons: (listener: () => void) => {
      listeners.add(listener);
      if (store.state === null) loadAeTablerIcons().catch(() => undefined);
      return () => {
        listeners.delete(listener);
      };
    },
    loadAeTablerIcons,
    loadAeTablerIconTags: () => Promise.resolve(tags),
  };
  const reset = () => {
    store.state = null;
    store.failing = false;
    store.loads = 0;
  };
  return { store, module, reset };
}
