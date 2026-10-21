// The native shells (iOS, Android) hide the breadcrumb's folder and sub-agent
// segments, but keep the session title: their own chrome does not name the
// session. jsdom applies no app stylesheet, so this loads the real native rule
// from index.css and checks what it hides.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConversationBreadcrumb } from "./ConversationBreadcrumb";
import { HeaderTitle } from "./HeaderTitle";

vi.mock("@/hooks/useConversations", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRenameConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexCss = readFileSync(path.join(srcDir, "index.css"), "utf8");
// Every rule whose selector names the native shells and the breadcrumb.
const nativeRules = [
  ...indexCss.matchAll(
    /(\[data-(?:ios|android)-native\][^{]*conversation-breadcrumb[^{]*)\{([^}]*)\}/g,
  ),
]
  .map((m) => `${m[1]}{${m[2]}}`)
  .join("\n");

let style: HTMLStyleElement | null = null;

afterEach(() => {
  style?.remove();
  style = null;
});

function renderInShell(
  shell: "ios" | "android",
  props: { titleLinkTo?: string; renameable?: boolean } = {},
) {
  style = document.createElement("style");
  style.textContent = nativeRules;
  document.head.appendChild(style);
  const view = render(
    <div {...{ [`data-${shell}-native`]: "" }}>
      <MemoryRouter>
        <TooltipProvider>
          <ConversationBreadcrumb
            conversationTitle="UX for multiple autocomplete suggestions"
            projectName="reid"
            isChildSession={Boolean(props.titleLinkTo)}
            subAgentName="Explore"
            boundAgent={undefined}
            wrapperLabel={null}
            titleLinkTo={props.titleLinkTo}
            titleSlot={
              props.renameable ? (
                <HeaderTitle
                  conversationId="conv_a"
                  title="UX for multiple autocomplete suggestions"
                />
              ) : undefined
            }
          />
        </TooltipProvider>
      </MemoryRouter>
    </div>,
  );
  return view.container;
}

const shown = (el: Element | null) => el !== null && getComputedStyle(el).display !== "none";

describe("ConversationBreadcrumb in a native shell", () => {
  it("loads the native rules from index.css", () => {
    expect(nativeRules).toContain("breadcrumb-title");
  });

  it.each(["ios", "android"] as const)(
    "%s shows the session title and hides the folder",
    (shell) => {
      const container = renderInShell(shell);
      const nav = container.querySelector("nav.conversation-breadcrumb");
      const title = container.querySelector(".breadcrumb-title");
      expect(shown(nav)).toBe(true);
      expect(title).toHaveTextContent("UX for multiple autocomplete suggestions");
      expect(shown(title)).toBe(true);
      const folder = container.querySelector(".breadcrumb-folder")?.parentElement ?? null;
      expect(folder).not.toBeNull();
      expect(shown(folder)).toBe(false);
    },
  );

  it("shows the click-to-rename title of wider native shells (iPad) too", () => {
    const container = renderInShell("ios", { renameable: true });
    const title = container.querySelector("[data-testid=header-title]");
    expect(title).toHaveTextContent("UX for multiple autocomplete suggestions");
    expect(shown(title)).toBe(true);
  });

  it("a sub-agent keeps only the back link", () => {
    const container = renderInShell("ios", { titleLinkTo: "/c/parent" });
    const nav = container.querySelector("nav.conversation-breadcrumb")!;
    const visible = [...nav.children].filter(shown);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toHaveClass("breadcrumb-parent-link");
  });
});
