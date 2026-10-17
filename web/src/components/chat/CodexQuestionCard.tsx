import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AskUserQuestionForm,
  type AskUserQuestionAnswers,
} from "@/components/blocks/AskUserQuestionForm";
import type { CodexQuestion } from "@/lib/blocks";
import { useChatStore } from "@/store/chatStore";
import { aeCodexAnswerText, aeCodexAsClaudeQuestions } from "./aeCodexQuestions";

/** Codex's questions inline in the chat, in the same form Claude's questions use. */
export function CodexQuestionCard({
  conversationId,
  itemId,
  questions,
}: {
  conversationId: string;
  itemId: string;
  questions: CodexQuestion[];
}) {
  const storageKey = `codex-question:${conversationId}:${itemId}`;
  const formQuestions = useMemo(() => aeCodexAsClaudeQuestions(questions), [questions]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(() => localStorage.getItem(`${storageKey}:sent`) === "1");
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(`${storageKey}:dismissed`) === "1",
  );
  const submitting = useRef(false);

  if (sent) return null;
  if (dismissed) {
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto self-start p-0 text-muted-foreground"
        onClick={() => {
          localStorage.removeItem(`${storageKey}:dismissed`);
          setDismissed(false);
        }}
      >
        Show Codex's question
      </Button>
    );
  }

  const submit = async (answers: AskUserQuestionAnswers) => {
    if (submitting.current) return;
    const chat = useChatStore.getState();
    if (chat.conversationId !== conversationId || !chat.boundAgentId) {
      setError("Open this session to answer the question.");
      return;
    }
    submitting.current = true;
    setPending(true);
    setError("");
    let failed = false;
    try {
      let stableId = localStorage.getItem(`${storageKey}:send-id`);
      if (!stableId) {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${conversationId}:${itemId}`),
        );
        stableId = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        localStorage.setItem(`${storageKey}:send-id`, stableId);
      }
      await chat.send(aeCodexAnswerText(questions, answers), chat.boundAgentId, undefined, {
        stableId,
        pinnedConversationId: conversationId,
        onError: (message) => {
          failed = true;
          setError(message);
        },
      });
      if (!failed) {
        localStorage.setItem(`${storageKey}:sent`, "1");
        setSent(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send answer.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      data-testid="codex-question-card"
      aria-busy={pending}
    >
      <p className="text-sm font-medium">Codex has questions</p>
      <fieldset disabled={pending} className="contents">
        <AskUserQuestionForm
          questions={formQuestions}
          onSubmit={(answers) => void submit(answers)}
          onReject={() => {
            if (pending) return;
            localStorage.setItem(`${storageKey}:dismissed`, "1");
            setDismissed(true);
          }}
        />
      </fieldset>
      {pending && <p className="text-sm text-muted-foreground">Sending...</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
