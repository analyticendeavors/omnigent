import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexQuestionCard } from "./CodexQuestionCard";

const send = vi.fn();
vi.mock("@/store/chatStore", () => ({
  useChatStore: { getState: () => ({ conversationId: "conv_1", boundAgentId: "codex", send }) },
}));

beforeEach(() => {
  send.mockReset();
  localStorage.clear();
  vi.stubGlobal("crypto", {
    subtle: { digest: vi.fn(async () => new Uint8Array(32).fill(7).buffer) },
  });
});

describe("CodexQuestionCard", () => {
  it("sends one normal user answer and stays answered after reload", async () => {
    send.mockResolvedValue(undefined);
    const props = {
      conversationId: "conv_1",
      itemId: "item_1",
      questions: [{ title: "Which path?", options: ["A", "B"] }],
    };
    const view = render(<CodexQuestionCard {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe("Answer to Codex questions:\nWhich path?: B");
    expect(send.mock.calls[0][3]).toMatchObject({
      pinnedConversationId: "conv_1",
      stableId: "07070707070707070707070707070707",
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull());
    view.unmount();
    render(<CodexQuestionCard {...props} />);
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
  });

  it("accepts free text and leaves failed answers available to retry", async () => {
    send.mockImplementation(async (_text, _agent, _files, opts) => opts.onError("Offline"));
    render(
      <CodexQuestionCard
        conversationId="conv_1"
        itemId="item_2"
        questions={[{ title: "Describe it" }]}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Free text answer for Describe it" }), {
      target: { value: "My answer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Offline"));
    expect(screen.getByRole("button", { name: "Send answer" })).toBeEnabled();
    expect(localStorage.getItem("codex-question:conv_1:item_2:sent")).toBeNull();
  });

  it("reopens a dismissed prompt without answering it", () => {
    render(
      <CodexQuestionCard
        conversationId="conv_1"
        itemId="item_3"
        questions={[{ title: "Describe it" }]}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Codex has questions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Answer Codex questions" }));
    expect(screen.getByRole("dialog", { name: "Codex has questions" })).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });

  it("opens when an older pending prompt becomes newest", () => {
    const props = {
      conversationId: "conv_1",
      itemId: "item_4",
      questions: [{ title: "What next?" }],
    };
    const view = render(<CodexQuestionCard {...props} autoOpen={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<CodexQuestionCard {...props} autoOpen />);
    expect(screen.getByRole("dialog", { name: "Codex has questions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    view.unmount();
    render(<CodexQuestionCard {...props} autoOpen />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Answer Codex questions" })).toBeTruthy();
  });
});
