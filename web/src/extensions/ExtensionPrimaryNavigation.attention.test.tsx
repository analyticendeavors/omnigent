// The Admin Center row carries the Needs you badge and no other extension row does
// (omnigent-ae, 2026-11-03).
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const nav = (id: string, page: string) => ({
  id,
  label: id,
  page,
  icon: null,
  order: 1,
  when: null,
});
const extensions = [
  {
    object: "extension" as const,
    id: "analyticendeavors.parking-lot",
    display_name: "Admin Center",
    distribution: "ae",
    version: "1.0.0",
    extension_api: 1,
    status: "enabled" as const,
    permissions: [],
    pages: [
      { id: "ae.fabric", title: "Admin Center", route: "fabric", view: "fabric" },
      { id: "ae.other", title: "Other", route: "other", view: "other" },
    ],
    primary_navigation: [
      nav("analyticendeavors.parking-lot.fabric-nav", "ae.fabric"),
      nav("analyticendeavors.parking-lot.other-nav", "ae.other"),
    ],
    browser: { declared: true, has_styles: false, digest: "x", script_url: "/x", style_url: null },
  },
];

vi.mock("./ExtensionProvider", () => ({ useExtensions: () => extensions }));
vi.mock("@/components/AeAttentionBadge", () => ({
  AeAttentionBadge: () => <span data-testid="badge" />,
}));

import { ExtensionPrimaryNavigation } from "./ExtensionPrimaryNavigation";

describe("ExtensionPrimaryNavigation badge", () => {
  it("puts the badge on the Admin Center row only", () => {
    render(
      <MemoryRouter>
        <ExtensionPrimaryNavigation activePageId={null} />
      </MemoryRouter>,
    );
    const badges = screen.getAllByTestId("badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].closest("a")).toHaveAttribute(
      "href",
      "/extensions/analyticendeavors.parking-lot/fabric",
    );
  });
});
