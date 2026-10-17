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
  it("renders inline in Claude's question form, with no dialog", () => {
    render(
      <CodexQuestionCard
        conversationId="conv_1"
        itemId="item_0"
        questions={[{ title: "Which path?", options: ["A", "B"] }]}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("ask-user-question-form")).toBeTruthy();
    expect(screen.getByText("Which path?")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "B" })).toBeTruthy();
  });

  it("sends one normal user answer and stays answered after reload", async () => {
    send.mockResolvedValue(undefined);
    const props = {
      conversationId: "conv_1",
      itemId: "item_1",
      questions: [{ title: "Which path?", options: ["A", "B"] }],
    };
    const view = render(<CodexQuestionCard {...props} />);
    fireEvent.click(screen.getByRole("radio", { name: "B" }));
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe("Answer to Codex questions:\nWhich path?: B");
    expect(send.mock.calls[0][3]).toMatchObject({
      pinnedConversationId: "conv_1",
      stableId: "07070707070707070707070707070707",
    });
    await waitFor(() => expect(screen.queryByTestId("codex-question-card")).toBeNull());
    view.unmount();
    render(<CodexQuestionCard {...props} />);
    expect(screen.queryByTestId("codex-question-card")).toBeNull();
  });

  it("answers several questions in one message, free text included", async () => {
    send.mockResolvedValue(undefined);
    render(
      <CodexQuestionCard
        conversationId="conv_1"
        itemId="item_5"
        questions={[{ title: "Which path?", options: ["A", "B"] }, { title: "Why?" }]}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "A" }));
    fireEvent.click(screen.getByTestId("ask-user-question-next"));
    fireEvent.change(screen.getByTestId("ask-user-question-custom-input"), {
      target: { value: "  Faster\n  and safer  " },
    });
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // A line break in a typed answer must not start a line of its own.
    expect(send.mock.calls[0][0]).toBe(
      "Answer to Codex questions:\nWhich path?: A\nWhy?: Faster and safer",
    );
  });

  it("leaves a failed answer on screen to retry", async () => {
    send.mockImplementation(async (_text, _agent, _files, opts) => opts.onError("Offline"));
    render(
      <CodexQuestionCard
        conversationId="conv_1"
        itemId="item_2"
        questions={[{ title: "Describe it" }]}
      />,
    );
    fireEvent.change(screen.getByTestId("ask-user-question-custom-input"), {
      target: { value: "My answer" },
    });
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Offline"));
    expect(screen.getByTestId("ask-user-question-submit")).toBeEnabled();
    expect(localStorage.getItem("codex-question:conv_1:item_2:sent")).toBeNull();
  });

  it("cancel folds the card to a link that brings it back, without sending", () => {
    const props = {
      conversationId: "conv_1",
      itemId: "item_3",
      questions: [{ title: "Describe it" }],
    };
    const view = render(<CodexQuestionCard {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("codex-question-card")).toBeNull();
    expect(send).not.toHaveBeenCalled();
    view.unmount();
    render(<CodexQuestionCard {...props} />);
    expect(screen.queryByTestId("codex-question-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show Codex's question" }));
    expect(screen.getByTestId("codex-question-card")).toBeTruthy();
    expect(localStorage.getItem("codex-question:conv_1:item_3:dismissed")).toBeNull();
  });

  it("disables the form while the answer is sending", async () => {
    send.mockReturnValue(new Promise(() => {}));
    render(
      <CodexQuestionCard
        conversationId="conv_1"
        itemId="item_6"
        questions={[{ title: "Which path?", options: ["A", "B"] }]}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "A" }));
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    await waitFor(() => expect(screen.getByText("Sending...")).toBeTruthy());
    expect(screen.getByTestId("ask-user-question-submit")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
