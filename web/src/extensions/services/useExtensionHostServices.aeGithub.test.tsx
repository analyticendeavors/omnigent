// omnigent-ae patch P25 (2026-09-27): `navigation.openExternal` opens a GitHub
// pull request or issue URL the host never handed out (`lib/aeExternalUrls.ts`),
// and still refuses every other URL it did not hand out. P27 (2026-09-27): a
// tab the browser blocked rejects with PopupBlocked instead of passing as opened.
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
  let tab: Window;

  beforeEach(() => {
    tab = { opener: window } as unknown as Window;
    open = vi.spyOn(window, "open").mockReturnValue(tab);
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
    // P27: opened without noopener so a block is visible, then the opener cut.
    expect(open).toHaveBeenCalledWith(url, "_blank");
    expect(tab.opener).toBeNull();
  });

  it("rejects with PopupBlocked when the browser blocks the new tab (P27)", async () => {
    open.mockReturnValue(null);
    await expect(
      openExternal()?.({ url: "https://github.com/acme/repo/pull/1" }, signal()),
    ).rejects.toMatchObject({ code: "PopupBlocked" });
  });

  it("keeps upstream's noopener open in a native shell, whose policy reports null (P27)", async () => {
    open.mockReturnValue(null);
    Object.assign(window, { omnigentDesktop: { kind: "electron" } });
    try {
      await expect(
        openExternal()?.({ url: "https://github.com/acme/repo/pull/1" }, signal()),
      ).resolves.toBeNull();
      expect(open).toHaveBeenCalledWith(
        "https://github.com/acme/repo/pull/1",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      Reflect.deleteProperty(window, "omnigentDesktop");
    }
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
