// Native Codex questions shown with Claude's question form (AE patch).
//
// Only the newest question still waiting is shown: any later user message,
// a plain chat reply included, means the conversation moved on, and a newer
// question supersedes an older one.

import type { AskUserQuestionAnswers } from "@/components/blocks/AskUserQuestionForm";
import type { ClaudeQuestion } from "@/lib/askUserQuestion";
import type { AnyBlock, CodexQuestion } from "@/lib/blocks";
import { isSystemUserContent } from "@/lib/systemMessage";

export const AE_CODEX_ANSWER_PREFIX = "Answer to Codex questions:";

/** The newest Codex question set that no user message has followed yet. */
export function aePendingCodexQuestions(
  blocks: AnyBlock[],
): { itemId: string; questions: CodexQuestion[] }[] {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (block.type === "user_message" && !isSystemUserContent(block.content)) return [];
    if (block.type === "text_done" && block.codexQuestions?.length) {
      // A newer question with no item id still supersedes older ones.
      return block.ctx.itemId
        ? [{ itemId: block.ctx.itemId, questions: block.codexQuestions }]
        : [];
    }
  }
  return [];
}

function questionId(index: number): string {
  return `codex-${index}`;
}

/** Codex's questions in the shape AskUserQuestionForm renders. */
export function aeCodexAsClaudeQuestions(questions: CodexQuestion[]): ClaudeQuestion[] {
  return questions.map((question, index) => ({
    id: questionId(index),
    question: question.title,
    options: (question.options ?? []).map((label) => ({ label })),
    multiSelect: false,
  }));
}

/** Line breaks fold to spaces so each answer stays on its own line. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** The one user message that answers them, one "title: answer" line each. */
export function aeCodexAnswerText(
  questions: CodexQuestion[],
  answers: AskUserQuestionAnswers,
): string {
  return [
    AE_CODEX_ANSWER_PREFIX,
    ...questions.map((question, index) => {
      const answer = answers[questionId(index)];
      return `${oneLine(question.title)}: ${oneLine(typeof answer === "string" ? answer : "")}`;
    }),
  ].join("\n");
}
