import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CodexQuestion } from "@/lib/blocks";
import { useChatStore } from "@/store/chatStore";

export function isCodexQuestionAnswer(text: string, questions: CodexQuestion[]): boolean {
  return (
    text.startsWith("Answer to Codex questions:\n") &&
    questions.every((question) => text.includes(`\n${question.title}: `))
  );
}

export function CodexQuestionCard({
  conversationId,
  itemId,
  questions,
  autoOpen = true,
}: {
  conversationId: string;
  itemId: string;
  questions: CodexQuestion[];
  autoOpen?: boolean;
}) {
  const storageKey = `codex-question:${conversationId}:${itemId}`;
  const [answers, setAnswers] = useState(() => questions.map(() => ""));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(() => localStorage.getItem(`${storageKey}:sent`) === "1");
  const [open, setOpen] = useState(
    () => autoOpen && localStorage.getItem(`${storageKey}:dismissed`) !== "1",
  );
  const submitting = useRef(false);

  useEffect(() => {
    setOpen(autoOpen && localStorage.getItem(`${storageKey}:dismissed`) !== "1");
  }, [autoOpen, storageKey]);

  if (sent) return null;

  const submit = async () => {
    if (submitting.current || answers.some((answer) => !answer.trim())) return;
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
      const answer = [
        "Answer to Codex questions:",
        ...questions.map((question, index) => `${question.title}: ${answers[index]!.trim()}`),
      ].join("\n");
      await chat.send(answer, chat.boundAgentId, undefined, {
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
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          localStorage.removeItem(`${storageKey}:dismissed`);
          setOpen(true);
        }}
      >
        Answer Codex questions
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
          if (!next) localStorage.setItem(`${storageKey}:dismissed`, "1");
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Codex has questions</DialogTitle>
          </DialogHeader>
          {questions.map((question, index) => (
            <div
              className="mb-3 space-y-2"
              key={`${question.title}:${question.options?.join("|") ?? ""}`}
            >
              <p className="text-sm">{question.title}</p>
              {!!question.options?.length && (
                <div className="flex flex-wrap gap-2">
                  {question.options.map((option) => (
                    <Button
                      type="button"
                      variant={answers[index] === option ? "default" : "outline"}
                      size="sm"
                      key={option}
                      disabled={pending}
                      aria-pressed={answers[index] === option}
                      onClick={() =>
                        setAnswers((current) =>
                          current.map((value, i) => (i === index ? option : value)),
                        )
                      }
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              )}
              <Input
                aria-label={`Free text answer for ${question.title}`}
                placeholder="Or type an answer"
                value={answers[index]}
                disabled={pending}
                onChange={(event) =>
                  setAnswers((current) =>
                    current.map((value, i) => (i === index ? event.target.value : value)),
                  )
                }
              />
            </div>
          ))}
          {error && (
            <p role="alert" className="mb-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            type="button"
            size="sm"
            disabled={pending || answers.some((answer) => !answer.trim())}
            onClick={() => void submit()}
          >
            {pending ? "Sending..." : "Send answer"}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
