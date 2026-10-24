import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const preset = (id: string, title: string) => ({
  id,
  title,
  icon: "scale",
  color: "teal",
  description: "",
  when_to_use: "",
  pinned: true,
  roles: {
    lead: { mode: "session" },
    planner: { mode: "auto" },
    reviewer: { mode: "auto" },
    builder: { mode: "auto" },
    helper: { mode: "auto" },
  },
  rules: {},
});
vi.mock("@/hooks/useSession", () => ({ useSession: () => ({ session: undefined }) }));
vi.mock("@/lib/routing", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/useIsMobileViewport", () => ({ useIsMobileViewport: () => false }));
vi.mock("@/hooks/useAeRoles", () => ({
  useAeRoles: () => ({
    data: {
      revision: 1,
      default_preset: "balanced",
      apply_start_on: true,
      presets: [preset("balanced", "Balanced"), preset("yolo", "YOLO")],
      starters: [],
    },
  }),
}));

import { aeGetDraftPick, aeSetDraftPick } from "@/lib/aeDraftPreset";
import { AeSessionPresetPill } from "./AeSessionPresetPill";

afterEach(() => {
  cleanup();
  aeSetDraftPick(null);
});

function renderPill() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AeSessionPresetPill sessionId={null} />
    </QueryClientProvider>,
  );
}

describe("AeSessionPresetPill without a session", () => {
  it("shows the default preset, then the held pick, and has no sessions section", async () => {
    renderPill();
    const pill = screen.getByTestId("ae-preset-pill");
    expect(pill.textContent).toContain("Balanced");
    fireEvent.pointerDown(pill, { button: 0, ctrlKey: false });
    fireEvent.click(pill);
    const yolo = await screen.findByRole("menuitemradio", { name: /YOLO/ });
    expect(screen.queryByText("Who works on this?")).toBeNull();
    fireEvent.click(yolo);
    expect(aeGetDraftPick()).toBe("yolo");
    expect(screen.getByTestId("ae-preset-pill").textContent).toContain("YOLO");
  });
});
