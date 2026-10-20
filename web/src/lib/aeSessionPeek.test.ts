import { describe, expect, it } from "vitest";
import { askedQuestion, peekFromItems } from "./aeSessionPeek";

const call = (name: string, args: unknown, id = name) => ({
  type: "function_call",
  name,
  call_id: id,
  arguments: JSON.stringify(args),
});
const output = (id: string) => ({ type: "function_call_output", call_id: id, output: "x" });
const user = (at: number, text = "do it") => ({
  type: "message",
  role: "user",
  created_at: at,
  content: [{ type: "input_text", text }],
});
const reply = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

describe("peekFromItems", () => {
  it("reads the current turn's pending question, step and start", () => {
    const peek = peekFromItems([
      user(100),
      call("AskUserQuestion", { questions: [{ question: "Old question?" }] }, "q0"),
      user(200),
      call("Read", { file_path: "/a/b.ts" }, "r1"),
      output("r1"),
      call("AskUserQuestion", { questions: [{ question: "Force the deploy now?" }] }, "q1"),
    ]);
    expect(peek).toMatchObject({
      question: "Force the deploy now?",
      stepRunning: true,
      turnStartedAt: 200_000,
    });
  });

  it("drops a question already answered when a later step waits", () => {
    const peek = peekFromItems([
      user(1),
      call("AskUserQuestion", { questions: [{ question: "Which one?" }] }, "q1"),
      output("q1"),
      call("Bash", { description: "Deploy" }, "b1"),
    ]);
    expect(peek).toMatchObject({ question: null, step: "Deploy", stepRunning: true });
  });

  it("marks a step whose result arrived as no longer running", () => {
    const peek = peekFromItems([
      user(1),
      call("Read", { file_path: "/a/foo.ts" }, "r1"),
      output("r1"),
    ]);
    expect(peek).toMatchObject({ step: "Reading foo.ts", stepRunning: false });
  });

  it("reads past harness and agent notices to the user's own message", () => {
    const notice = { ...user(250), is_meta: true };
    const wake = user(260, "<task-notification>\n<task-id>x</task-id>\n</task-notification>");
    const peek = peekFromItems([
      user(200),
      call("Bash", { description: "Build" }, "b1"),
      notice,
      wake,
    ]);
    expect(peek).toMatchObject({ step: "Build", turnStartedAt: 200_000 });
  });

  it("never reaches into an earlier turn for a step", () => {
    const peek = peekFromItems([call("Bash", { description: "Old step" }), user(300)]);
    expect(peek).toMatchObject({ step: null, question: null, turnStartedAt: 300_000 });
  });

  it("keeps the last reply and the last error apart, each on one line", () => {
    const peek = peekFromItems([
      user(1),
      reply("## Done\n- **Compact:** moved `button`\n1. Next"),
      { type: "error", title: "Runner disconnected" },
    ]);
    expect(peek.lastReply).toBe("Done Compact: moved button Next");
    expect(peek.lastError).toBe("Runner disconnected");
    expect(peekFromItems([user(1), reply("x".repeat(400))]).lastReply).toHaveLength(140);
  });
});

describe("askedQuestion", () => {
  it("reads only an AskUserQuestion call's first question", () => {
    expect(askedQuestion(call("AskUserQuestion", { questions: [{ question: " Go? " }] }))).toBe(
      "Go?",
    );
    expect(askedQuestion(call("AskUserQuestion", { questions: [] }))).toBeNull();
    expect(askedQuestion(call("Bash", { question: "no" }))).toBeNull();
    expect(
      askedQuestion({ type: "function_call", name: "AskUserQuestion", arguments: "{" }),
    ).toBeNull();
  });
});
