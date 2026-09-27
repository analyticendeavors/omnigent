// omnigent-ae patch P25 (2026-09-27): `navigation.openExternal` opens a GitHub
// pull request or issue URL the host never handed out (`lib/aeExternalUrls.ts`),
// and still refuses every other URL it did not hand out.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCatalogItem } from "../types";

vi.mock("@/lib/routing", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/identity", () => ({
  authenticatedFetch: vi.fn(),
  resolveIdentity: async () => "user@example.com",
}));
vi.mock("@/lib/host", () => ({ getOmnigentServerIdentity: () => "server-a" }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));

import { useExtensionHostServices } from "./useExtensionHostServices";

function extensionWith(permissions: ExtensionCatalogItem["permissions"]): ExtensionCatalogItem {
  return {
    object: "extension",
    id: "acme.board",
    display_name: "Board",
    distribution: "acme-board",
    version: "1.0.0",
    extension_api: 1,
    status: "enabled",
    permissions,
    pages: [{ id: "acme.board.home", title: "Home", route: "home", view: "home" }],
    primary_navigation: [],
    browser: {
      declared: true,
      has_styles: false,
      digest: "digest",
      script_url: "/script",
      style_url: null,
    },
  };
}

const queryClient = new QueryClient();
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
const signal = () => new AbortController().signal;

function openExternal(permissions: ExtensionCatalogItem["permissions"] = ["navigation"]) {
  const { result } = renderHook(() => useExtensionHostServices(extensionWith(permissions)), {
    wrapper,
  });
  return result.current.methods["navigation.openExternal"];
}

describe("navigation.openExternal and GitHub links (P25)", () => {
  let open: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    open = vi.spyOn(window, "open").mockReturnValue(null);
  });

  afterEach(() => {
    open.mockRestore();
  });

  it.each([
    "https://github.com/analyticendeavors/omnigent-ae/pull/57",
    "https://github.com/analyticendeavors/omnigent-ae/issues/28",
    "https://github.com/omnigent-ai/omnigent/pull/6935/files",
  ])("opens %s without the host handing it out", async (url) => {
    await expect(openExternal()?.({ url }, signal())).resolves.toBeNull();
    expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
  });

  it.each([
    "https://example.com/acme/repo/pull/1",
    "https://github.com.evil.example/acme/repo/pull/1",
    "https://github.com/acme/repo/pull/1?tab=files",
    "https://github.com/acme/repo/settings",
    "javascript:alert(1)",
  ])("still refuses %s", async (url) => {
    await expect(openExternal()?.({ url }, signal())).rejects.toMatchObject({
      code: "PermissionDenied",
      message: "URL was not provided by the host",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("is not offered to an extension without the navigation permission", () => {
    expect(openExternal(["sessions.read"])).toBeUndefined();
  });
});
