import { afterEach, describe, expect, it } from "vitest";
import {
  activeEchoWords,
  ECHO_TAIL_MS,
  normalizeWords,
  notePlayback,
  recordSpoken,
  resetEcho,
  splitEcho,
} from "./aeVoiceEcho";

afterEach(resetEcho);

const REPLY = "The build passed and the review is next.";

function open(now: number): readonly string[] {
  const w = activeEchoWords(now);
  if (!w) throw new Error("no active echo window");
  return w;
}

describe("aeVoiceEcho", () => {
  it("normalizes case, punctuation and apostrophes", () => {
    expect(normalizeWords("Hello, World! It's fine.")).toEqual(["hello", "world", "its", "fine"]);
  });

  it("treats an exact echo of a spoken sentence as echo, not a barge", () => {
    recordSpoken(REPLY);
    notePlayback(true, 0);
    const r = splitEcho("the build passed and the review is next", open(100));
    expect(r.person).toBe(false);
    expect(r.fresh).toEqual([]);
  });

  it("does not barge on an echo run with one stray word", () => {
    recordSpoken(REPLY);
    notePlayback(true, 0);
    const r = splitEcho("the build passed banana", open(100));
    expect(r.person).toBe(false);
    expect(r.fresh).toEqual(["banana"]);
  });

  it("barges on two new words after an echo run and keeps only the new words", () => {
    recordSpoken(REPLY);
    notePlayback(true, 0);
    const r = splitEcho("the build passed Stop, please", open(100));
    expect(r.person).toBe(true);
    expect(r.fresh).toEqual(["Stop,", "please"]);
  });

  it("keeps real words that also appear in the reply, and drops a whole echoed run", () => {
    recordSpoken(REPLY);
    notePlayback(true, 0);
    const spoken = open(100);
    const kept = splitEcho("no the build should fail", spoken);
    expect(kept.fresh).toEqual(["no", "the", "build", "should", "fail"]);
    expect(kept.person).toBe(true);
    const echoed = splitEcho("the review is next", spoken);
    expect(echoed.fresh).toEqual([]);
    expect(echoed.person).toBe(false);
  });

  it("counts a heard text of one or two words as echo only when it is a spoken run", () => {
    recordSpoken(REPLY);
    notePlayback(true, 0);
    const spoken = open(100);
    expect(splitEcho("the review", spoken).fresh).toEqual([]);
    expect(splitEcho("build review", spoken).fresh).toEqual(["build", "review"]);
    expect(splitEcho("please", spoken).fresh).toEqual(["please"]);
  });

  it("keeps filtering for the tail after playback stops, then stops", () => {
    recordSpoken("Merge is done.");
    notePlayback(true, 0);
    notePlayback(false, 1000);
    expect(activeEchoWords(1000 + ECHO_TAIL_MS - 1)).not.toBeNull();
    expect(activeEchoWords(1000 + ECHO_TAIL_MS)).toBeNull();
  });

  it("a new playback opens a fresh window even inside the tail", () => {
    recordSpoken("Old reply words here.");
    notePlayback(true, 0);
    notePlayback(false, 100);
    recordSpoken("New reply sentence now.");
    notePlayback(true, 200);
    const words = open(300);
    expect(words).not.toContain("old");
    expect(words).toContain("new");
  });

  it("a caption before playback starts does not open the window", () => {
    recordSpoken("Queued but not playing yet.");
    expect(activeEchoWords(0)).toBeNull();
    notePlayback(true, 10);
    expect(open(20)).toContain("queued");
  });

  it("reset closes the window so playing cannot stay on", () => {
    recordSpoken(REPLY);
    notePlayback(true, 0);
    resetEcho();
    expect(activeEchoWords(10)).toBeNull();
  });
});
