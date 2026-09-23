import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AE_STATUS_VALUES } from "@/lib/aeLabels";
import { AeConversationStatusIcon, AeStatusIcon, AE_STATUS_WORDS } from "./AeStatusIcon";

afterEach(cleanup);

function renderIcon(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("AeStatusIcon", () => {
  it.each(AE_STATUS_VALUES)("renders %s as an image named by the status word", (status) => {
    renderIcon(<AeStatusIcon status={status} />);
    const icon = screen.getByRole("img", { name: AE_STATUS_WORDS[status] });
    expect(icon).toHaveAttribute("data-testid", "ae-status-icon");
    expect(icon).toHaveAttribute("data-status", status);
    // The lucide glyph is decoration; the span carries the name.
    expect(icon.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("uses one distinct glyph per status", () => {
    const markup = AE_STATUS_VALUES.map((status) => {
      const view = renderIcon(<AeStatusIcon status={status} />);
      const svg = view.container.querySelector("svg")!.innerHTML;
      view.unmount();
      return svg;
    });
    expect(new Set(markup).size).toBe(AE_STATUS_VALUES.length);
  });
});

describe("AeConversationStatusIcon", () => {
  it("renders nothing for a session without ae.status", () => {
    renderIcon(<AeConversationStatusIcon conversation={{ labels: {} }} />);
    expect(screen.queryByTestId("ae-status-icon")).toBeNull();
  });

  it("shows the stored status", () => {
    renderIcon(<AeConversationStatusIcon conversation={{ labels: { "ae.status": "parked" } }} />);
    expect(screen.getByRole("img", { name: "Parked" })).toHaveAttribute("data-status", "parked");
  });

  it("shows blocked for a working session waiting on an approval", () => {
    renderIcon(
      <AeConversationStatusIcon
        conversation={{ labels: { "ae.status": "working" }, pending_elicitations_count: 1 }}
      />,
    );
    expect(screen.getByRole("img", { name: "Blocked" })).toHaveAttribute("data-status", "blocked");
  });
});
