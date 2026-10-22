import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileMentionMenu } from "./FileMentionMenu";

afterEach(cleanup);

describe("FileMentionMenu surface", () => {
  it("blurs what is behind it, since the dark popover colour is only 80% opaque", () => {
    const { container } = render(
      <FileMentionMenu
        currentDir=""
        activeIndex={-1}
        entries={[
          { path: "README.md", name: "README.md", type: "file", bytes: 12, modified_at: null },
        ]}
        onOpenDir={vi.fn()}
        onAttach={vi.fn()}
      />,
    );
    const surface = container.querySelector(".bg-popover");
    expect(surface).toHaveClass("backdrop-blur-xl", "backdrop-saturate-150");
  });
});
