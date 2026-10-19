import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionMarker } from "@/components/blocks/StatusBlocks";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { ComposerContextRing } from "@/components/composer/ComposerContextRing";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AnyBlock, BlockContext } from "@/lib/blocks";
import {
  AE_DEFRAG_STALE_MS,
  AE_TOKEN_DEFRAG_KEY,
  aeNoteCompactionFailed,
  aeNoteCompactionTotals,
  resetAeTokenDefrag,
  writeAeTokenDefrag,
} from "@/lib/aeTokenDefrag";
import { AeChatSettingsSection } from "@/pages/settings/AeChatSettingsSection";
import { useChatStore } from "@/store/chatStore";
import { AeTokenDefrag, AeTokenDefragSetting } from "./AeTokenDefrag";

function ctx(itemId: string | null = null): BlockContext {
  return { agent: null, depth: 0, turn: 1, timestamp: 0, responseId: "r1", itemId };
}

const text = (): AnyBlock => ({ type: "text_done", ctx: ctx("m1") }) as unknown as AnyBlock;
const loading = (startedAtS = Date.now() / 1000): AnyBlock => ({
  type: "compaction_loading",
  ctx: ctx(),
  startedAtS,
});
const marker = (itemId: string | null = null): AnyBlock => ({
  type: "compaction",
  ctx: ctx(itemId),
});
/** A marker the page saw land, stamped like blockStream stamps live blocks. */
const liveMarker = (createdAtS = Math.floor(Date.now() / 1000)): AnyBlock => ({
  type: "compaction",
  ctx: { ...ctx(), clientCreatedAtS: createdAtS },
});

function setBlocks(blocks: AnyBlock[], tokensUsed = 168_000) {
  act(() => {
    useChatStore.setState({ blocks, tokensUsed, conversationId: "conv-1" });
  });
}

/** A finish as the stream delivers it: the tap notes it, then the store adds the marker. */
function finish(blocks: AnyBlock[], after = 51_000) {
  act(() => {
    aeNoteCompactionTotals("conv-1", useChatStore.getState().tokensUsed, after);
    useChatStore.setState({ blocks, tokensUsed: after, conversationId: "conv-1" });
  });
}

/** A failure as the stream delivers it: the tap notes it, then the store drops the loading blocks. */
function fail(blocks: AnyBlock[]) {
  act(() => {
    aeNoteCompactionFailed("conv-1");
    useChatStore.setState({ blocks, conversationId: "conv-1" });
  });
}

/** The strip and the ring as the composer tray mounts them, both reading the store. */
function Tray() {
  const tokensUsed = useChatStore((s) => s.tokensUsed);
  return (
    <TooltipProvider>
      <AeTokenDefrag />
      <ComposerContextRing contextWindow={1_000_000} tokensUsed={tokensUsed} />
    </TooltipProvider>
  );
}

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const label = () => screen.getByTestId("ae-token-defrag-label");

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "performance",
      "Date",
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetAeTokenDefrag();
  window.localStorage.removeItem(AE_TOKEN_DEFRAG_KEY);
  useChatStore.setState({ blocks: [], tokensUsed: null, conversationId: null });
});

describe("AeTokenDefrag", () => {
  it("renders nothing while no compaction runs", () => {
    setBlocks([text()]);
    render(<AeTokenDefrag />);
    expect(screen.queryByTestId("ae-token-defrag")).toBeNull();
  });

  it("paints the starting layout on the first frame", () => {
    setBlocks([text(), loading()]);
    render(<AeTokenDefrag />);
    advance(50);
    const strip = screen.getByTestId("ae-token-defrag");
    expect(strip.querySelectorAll('[data-kind="fixed"]')).toHaveLength(5);
    expect(strip.querySelectorAll('[data-kind="message"]')).toHaveLength(40);
  });

  it("shows the strip while compaction runs and counts up", () => {
    setBlocks([text(), loading()]);
    render(<AeTokenDefrag />);
    expect(screen.getByTestId("ae-token-defrag")).toHaveAttribute(
      "title",
      "Defragmenting Context C:",
    );
    advance(20_000);
    const percent = Number.parseInt(label().textContent ?? "", 10);
    expect(percent).toBeGreaterThan(10);
    expect(percent).toBeLessThan(97);
  });

  it("finishes on the stream's finish, holds the ring until the pills land, then goes away", () => {
    setBlocks([text(), loading()]);
    render(<Tray />);
    advance(3_000);
    finish([text(), loading(), liveMarker()], 51_000);
    expect(screen.getByLabelText("17% of context used")).toBeInTheDocument();
    advance(4_000);
    expect(label()).toHaveTextContent("100%");
    advance(4_000);
    expect(screen.queryByTestId("ae-token-defrag")).toBeNull();
    expect(screen.getByLabelText("5% of context used")).toBeInTheDocument();
  });

  it("says so when the stream reports a failure, then goes away", () => {
    setBlocks([text(), loading()]);
    render(<AeTokenDefrag />);
    advance(2_000);
    fail([text()]);
    expect(label()).toHaveTextContent("Compaction failed, history unchanged");
    advance(4_000);
    expect(screen.queryByTestId("ae-token-defrag")).toBeNull();
  });

  it("reads a failure as a failure after an earlier compaction finished", () => {
    const first = liveMarker();
    setBlocks([text(), loading(), first]);
    render(<AeTokenDefrag />);
    setBlocks([text(), loading(), first, text(), loading()]);
    advance(2_000);
    // The store's failure handler drops every loading block, so the first marker's index moves.
    fail([text(), first, text()]);
    expect(label()).toHaveTextContent("Compaction failed, history unchanged");
  });

  it("never calls a reconnect a finish, and stops quietly when nothing comes back", () => {
    setBlocks([text(), loading()]);
    render(<AeTokenDefrag />);
    advance(2_000);
    // A reconnect swaps the live blocks for history: no loading block, an older marker with an id.
    setBlocks([marker("item_prev"), text()]);
    advance(5_000);
    expect(label()).not.toHaveTextContent("100%");
    advance(4_000);
    expect(screen.queryByTestId("ae-token-defrag")).toBeNull();
  });

  it("keeps running through a reconnect when the server announces the compaction again", () => {
    const start = Date.now() / 1000;
    setBlocks([text(), loading(start)]);
    render(<AeTokenDefrag />);
    advance(2_000);
    setBlocks([marker("item_prev"), text()]);
    advance(3_000);
    setBlocks([marker("item_prev"), text(), loading(start)]);
    advance(10_000);
    expect(label()).toHaveTextContent(/^\d+%$/);
  });

  it("lets the ring show live usage once the turn moves on without a finish", () => {
    setBlocks([text(), loading()], 168_000);
    render(<Tray />);
    advance(1_000);
    expect(screen.getByLabelText("17% of context used")).toBeInTheDocument();
    setBlocks([text(), loading()], 250_000);
    expect(screen.getByLabelText("25% of context used")).toBeInTheDocument();
  });

  it("gives up a run that never finishes and lets the ring go", () => {
    setBlocks([text(), loading()]);
    render(
      <TooltipProvider>
        <AeTokenDefrag />
        <ComposerContextRing contextWindow={1_000_000} tokensUsed={200_000} />
      </TooltipProvider>,
    );
    advance(1_000);
    expect(screen.getByLabelText("17% of context used")).toBeInTheDocument();
    advance(AE_DEFRAG_STALE_MS + 1_000);
    expect(screen.queryByTestId("ae-token-defrag")).toBeNull();
    expect(screen.getByLabelText("20% of context used")).toBeInTheDocument();
  });

  it("trusts this clock when the server's start is far off", () => {
    setBlocks([text(), loading(Date.now() / 1000 + 1_200)]);
    const { unmount } = render(<AeTokenDefrag />);
    advance(20_000);
    expect(Number.parseInt(label().textContent ?? "", 10)).toBeGreaterThan(10);
    unmount();
    setBlocks([text(), loading(Date.now() / 1000 - 1_800)]);
    render(<AeTokenDefrag />);
    advance(1_000);
    expect(screen.getByTestId("ae-token-defrag")).toBeInTheDocument();
  });

  it("stays hidden when switched off in Settings", () => {
    writeAeTokenDefrag(false);
    setBlocks([text(), loading()]);
    render(<AeTokenDefrag />);
    expect(screen.queryByTestId("ae-token-defrag")).toBeNull();
  });

  it("opens the hidden window on click, with its legend, and closes it", () => {
    setBlocks([text(), loading()]);
    render(<AeTokenDefrag />);
    advance(1_000);
    fireEvent.click(screen.getByTestId("ae-token-defrag"));
    expect(screen.getByRole("dialog", { name: "Defragmenting Context C:" })).toBeInTheDocument();
    expect(screen.getByTestId("ae-token-defrag-map").children).toHaveLength(560);
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Legend" }));
    expect(screen.getByText("Will not be moved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide Details" }));
    expect(screen.queryByRole("dialog", { name: "Defragmenting Context C:" })).toBeNull();
  });

  it("keeps the completion box, with its counts, until OK", () => {
    setBlocks([text(), loading()]);
    render(<AeTokenDefrag />);
    advance(1_000);
    fireEvent.click(screen.getByTestId("ae-token-defrag"));
    finish([text(), loading(), liveMarker()], 50_512);
    // Each stage's effects run between steps, as they do between browser frames.
    advance(5_000);
    advance(5_000);
    const box = screen.getByRole("alertdialog", { name: "Disk Defragmenter" });
    expect(box).toHaveTextContent("Defragmentation of Context C: is complete.");
    expect(box).toHaveTextContent(/168.*→.*50.*tokens/);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByTestId("ae-token-defrag")).toBeNull();
  });

  it("starts the next run with a fresh strip when the last run's window stayed open", () => {
    setBlocks([text(), loading()]);
    render(<AeTokenDefrag />);
    advance(1_000);
    fireEvent.click(screen.getByTestId("ae-token-defrag"));
    const first = liveMarker();
    finish([text(), loading(), first], 51_000);
    advance(5_000);
    advance(5_000);
    setBlocks([text(), first, text(), loading()], 51_000);
    advance(1_000);
    const strip = screen.getByTestId("ae-token-defrag");
    expect(strip.querySelectorAll('[data-kind="fixed"]')).toHaveLength(5);
  });

  it("keeps the failure box until OK", () => {
    setBlocks([text(), loading()]);
    render(<AeTokenDefrag />);
    advance(1_000);
    fireEvent.click(screen.getByTestId("ae-token-defrag"));
    fail([text()]);
    advance(5_000);
    advance(5_000);
    expect(screen.getByRole("alertdialog", { name: "Disk Defragmenter" })).toHaveTextContent(
      "history unchanged",
    );
    expect(label()).toHaveTextContent("Compaction failed, history unchanged");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByTestId("ae-token-defrag")).toBeNull();
  });
});

describe("CompactionMarker token counts", () => {
  it("shows before and after for the compaction this page watched finish", () => {
    aeNoteCompactionTotals("conv-1", 168_204, 50_512);
    setBlocks([text(), liveMarker()]);
    render(<CompactionMarker itemId="compaction_1" />);
    expect(screen.getByTestId("ae-compaction-totals")).toHaveTextContent(/168.*→.*50.*tokens/);
  });

  it("reads as before for an older marker, even before the new one lands", () => {
    const older = liveMarker(Math.floor(Date.now() / 1000) - 600);
    setBlocks([older, text()]);
    render(<CompactionMarker itemId="compaction_0" />);
    // The stream tap notes the counts before the new marker block reaches the store.
    act(() => aeNoteCompactionTotals("conv-1", 168_204, 50_512));
    expect(screen.queryByTestId("ae-compaction-totals")).toBeNull();
    setBlocks([older, text(), liveMarker()]);
    expect(screen.queryByTestId("ae-compaction-totals")).toBeNull();
    expect(screen.getByText("Conversation compacted")).toBeInTheDocument();
  });

  it("keeps the counts of a marker that was off screen when a later compaction landed", () => {
    aeNoteCompactionTotals("conv-1", 168_204, 50_512);
    const first = liveMarker();
    advance(60_000);
    aeNoteCompactionTotals("conv-1", 120_000, 40_000);
    setBlocks([first, text(), liveMarker()]);
    render(<CompactionMarker itemId="compaction_0" />);
    expect(screen.getByTestId("ae-compaction-totals")).toHaveTextContent(/168.*→.*50.*tokens/);
  });

  it("shows nothing for a side chat's marker, whose bubbles index a filtered copy", () => {
    aeNoteCompactionTotals("conv-1", 168_204, 50_512);
    setBlocks([text(), liveMarker()]);
    render(
      <ConversationScopeContext.Provider value="child-1">
        <CompactionMarker itemId="compaction_1" />
      </ConversationScopeContext.Provider>,
    );
    expect(screen.getByText("Conversation compacted")).toBeInTheDocument();
    expect(screen.queryByTestId("ae-compaction-totals")).toBeNull();
  });

  it("shows nothing for a marker loaded from history", () => {
    aeNoteCompactionTotals("conv-1", 168_204, 50_512);
    setBlocks([text(), marker("item_9")]);
    render(<CompactionMarker itemId="item_9" />);
    expect(screen.queryByTestId("ae-compaction-totals")).toBeNull();
  });
});

describe("AeTokenDefragSetting", () => {
  it("sits in Settings > Chat", () => {
    vi.useRealTimers();
    render(<AeChatSettingsSection />);
    expect(screen.getByText("Token defrag")).toBeInTheDocument();
  });

  it("switches the animation off and on", () => {
    vi.useRealTimers();
    render(<AeTokenDefragSetting />);
    const toggle = screen.getByTestId("ae-token-defrag-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(window.localStorage.getItem(AE_TOKEN_DEFRAG_KEY)).toBe("off");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
