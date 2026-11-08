import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { subscribeToQueryKeys } from "./aeQueryCacheSubscribe";

describe("subscribeToQueryKeys", () => {
  it("fires for a matching key and a longer key under the prefix", () => {
    const client = new QueryClient();
    const onChange = vi.fn();
    subscribeToQueryKeys(client, [["conversations"]], onChange);
    client.setQueryData(["conversations"], 1);
    expect(onChange).toHaveBeenCalled();
    onChange.mockClear();
    client.setQueryData(["conversations", "list", { a: 1 }], 1);
    expect(onChange).toHaveBeenCalled();
    onChange.mockClear();
    client.setQueryData(["conversations", "list", { a: 1 }], 2);
    expect(onChange).toHaveBeenCalled();
  });

  it("matches any of several keys", () => {
    const client = new QueryClient();
    const onChange = vi.fn();
    subscribeToQueryKeys(client, [["conversations"], ["ae", "helpers-count"]], onChange);
    client.setQueryData(["ae", "helpers-count"], true);
    expect(onChange).toHaveBeenCalled();
  });

  it("does not fire for a non-matching key", () => {
    const client = new QueryClient();
    const onChange = vi.fn();
    subscribeToQueryKeys(client, [["conversations"]], onChange);
    client.setQueryData(["session", "a"], 1);
    client.setQueryData(["ae", "helpers-count"], true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not fire for observer-only events", () => {
    const client = new QueryClient();
    client.setQueryData(["conversations"], 1);
    const onChange = vi.fn();
    subscribeToQueryKeys(client, [["conversations"]], onChange);
    const query = client.getQueryCache().find({ queryKey: ["conversations"] })!;
    const observer = { onQueryUpdate: () => {} } as never;
    query.addObserver(observer);
    query.removeObserver(observer);
    client.getQueryCache().notify({ type: "observerResultsUpdated", query });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops after unsubscribe", () => {
    const client = new QueryClient();
    const onChange = vi.fn();
    const unsubscribe = subscribeToQueryKeys(client, [["conversations"]], onChange);
    unsubscribe();
    client.setQueryData(["conversations"], 1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
