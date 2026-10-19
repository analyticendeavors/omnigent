import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyBlock, BlockContext } from "@/lib/blocks";
import {
  AE_DEFRAG_MESSAGES,
  AE_DEFRAG_SCAN_LIMIT,
  AE_TOKEN_DEFRAG_KEY,
  type AeDefragPill,
  type AeDefragStrip,
  aeCompactionCountsFor,
  aeCompactionPhase,
  aeCompactionTotalsFor,
  aeCreateDefragMap,
  aeCreateDefragStrip,
  aeDefragEstimate,
  aeDefragShown,
  aeDefragStripDrained,
  aeDefragStripResting,
  aeLiveMarkerStamps,
  aeNoteCompactionFailed,
  aeNoteCompactionTotals,
  aeNotedCompactionTotals,
  aeStepDefragStrip,
  aeTickDefragMap,
  parseAeCompactionPhase,
  readAeTokenDefrag,
  resetAeTokenDefrag,
  writeAeTokenDefrag,
} from "./aeTokenDefrag";
import { aeObserveStreamEvent } from "./aeStreamObserver";

function ctx(itemId: string | null = null): BlockContext {
  return { agent: null, depth: 0, turn: 1, timestamp: 0, responseId: "r1", itemId };
}

const message = (): AnyBlock => ({ type: "text_done", ctx: ctx("m") }) as unknown as AnyBlock;
const loading = (startedAtS?: number): AnyBlock => ({
  type: "compaction_loading",
  ctx: ctx(),
  ...(startedAtS === undefined ? {} : { startedAtS }),
});
const marker = (itemId: string | null = null): AnyBlock => ({
  type: "compaction",
  ctx: ctx(itemId),
});
/** A marker the page saw land, stamped like blockStream stamps live blocks. */
const liveMarker = (clientCreatedAtS: number): AnyBlock => ({
  type: "compaction",
  ctx: { ...ctx(), clientCreatedAtS },
});

/** Pills resting on the track (not in the air), left to right. */
function onTrack(strip: AeDefragStrip): AeDefragPill[] {
  return [...strip.fixed, ...strip.messages, ...strip.summaries]
    .filter((pill) => pill && !pill.gone && !pill.flying && pill.w > 0.5)
    .sort((a, b) => a.x - b.x);
}

afterEach(() => {
  vi.useRealTimers();
  resetAeTokenDefrag();
  window.localStorage.removeItem(AE_TOKEN_DEFRAG_KEY);
});

describe("aeCompactionPhase", () => {
  it("is idle without compaction blocks", () => {
    expect(aeCompactionPhase([message(), message()])).toBe("idle");
    expect(parseAeCompactionPhase("idle")).toEqual({ kind: "idle" });
  });

  it("runs from the earliest start among a compaction's loading blocks", () => {
    const phase = aeCompactionPhase([message(), loading(120), message(), loading(100)]);
    expect(phase).toBe("run:100");
    expect(parseAeCompactionPhase(phase)).toEqual({ kind: "running", startedAtS: 100 });
  });

  it("is idle once a marker follows the loading blocks, which the store keeps", () => {
    expect(aeCompactionPhase([message(), loading(100), marker()])).toBe("idle");
    expect(aeCompactionPhase([loading(100), marker("a"), message()])).toBe("idle");
  });

  it("runs again for a later compaction, with no start when none was stamped", () => {
    const phase = aeCompactionPhase([loading(100), marker("a"), message(), loading()]);
    expect(phase).toBe("run:");
    expect(parseAeCompactionPhase(phase)).toEqual({ kind: "running", startedAtS: null });
  });

  it("ignores a stranded loading block further back than the scan limit", () => {
    const filler = Array.from({ length: AE_DEFRAG_SCAN_LIMIT }, () => message());
    expect(aeCompactionPhase([loading(100), ...filler])).toBe("idle");
  });

  it("returns the cached answer for the same blocks array", () => {
    const blocks = [message(), loading(100)];
    expect(aeCompactionPhase(blocks)).toBe("run:100");
    blocks.pop();
    expect(aeCompactionPhase(blocks)).toBe("run:100");
  });
});

describe("aeLiveMarkerStamps", () => {
  it("maps each marker this page saw land to its stamp, by its bubble key", () => {
    const blocks = [marker("item_a"), message(), liveMarker(100), loading(90)];
    const stamps = aeLiveMarkerStamps(blocks);
    expect([...stamps]).toEqual([["compaction_2", 100]]);
    expect(aeLiveMarkerStamps(blocks)).toBe(stamps);
  });
});

describe("aeDefragEstimate", () => {
  it("climbs from zero toward 97% and never reaches it", () => {
    expect(aeDefragEstimate(0)).toBe(0);
    expect(aeDefragEstimate(-5)).toBe(0);
    expect(aeDefragEstimate(40_000)).toBeCloseTo(0.97 * (1 - Math.exp(-1)), 5);
    expect(aeDefragEstimate(20_000)).toBeLessThan(aeDefragEstimate(30_000));
    expect(aeDefragEstimate(10_000_000)).toBeLessThanOrEqual(0.97);
  });
});

describe("the pill strip", () => {
  it("lays out the fixed pills, then the messages to their right", () => {
    const strip = aeCreateDefragStrip();
    expect(strip.fixed).toHaveLength(5);
    expect(strip.messages).toHaveLength(AE_DEFRAG_MESSAGES);
    const lastFixed = strip.fixed[strip.fixed.length - 1];
    expect(strip.messages[0].x).toBeGreaterThan(lastFixed.x + lastFixed.w);
    for (let i = 1; i < strip.messages.length; i += 1) {
      expect(strip.messages[i].x).toBeGreaterThan(strip.messages[i - 1].x);
    }
  });

  it("launches one pill per beat, keeps the track free of overlaps, and drains", () => {
    const strip = aeCreateDefragStrip();
    let maxInAir = 0;
    let steps = 0;
    for (let ms = 0; !aeDefragStripDrained(strip) && steps < 5000; ms += 16, steps += 1) {
      const finishing = ms > 6000;
      const target = Math.floor(aeDefragEstimate(ms, 4000) * AE_DEFRAG_MESSAGES);
      const step = aeStepDefragStrip(strip, 16, finishing ? AE_DEFRAG_MESSAGES : target, finishing);
      expect(step.launched.length).toBeLessThanOrEqual(1);
      maxInAir = Math.max(maxInAir, strip.flying.length);
      const track = onTrack(strip);
      for (let i = 1; i < track.length; i += 1) {
        expect(track[i].x).toBeGreaterThanOrEqual(track[i - 1].x + track[i - 1].w - 0.5);
      }
    }
    expect(aeDefragStripDrained(strip)).toBe(true);
    expect(strip.absorbed).toBe(AE_DEFRAG_MESSAGES);
    expect(strip.messages.every((pill) => pill.gone)).toBe(true);
    expect(aeDefragShown(strip)).toBe(1);
    expect(maxInAir).toBeLessThanOrEqual(4);
    for (const summary of strip.summaries) {
      expect(summary.w0).toBeGreaterThan(0);
      expect(summary.w0).toBeLessThanOrEqual(24);
    }
  });

  it("never launches past the target while running, then rests", () => {
    const strip = aeCreateDefragStrip();
    expect(aeDefragStripResting(strip)).toBe(true);
    aeStepDefragStrip(strip, 200, 1, false);
    expect(aeDefragStripResting(strip)).toBe(false);
    for (let i = 0; i < 400; i += 1) aeStepDefragStrip(strip, 16, 3, false);
    expect(strip.next).toBe(3);
    expect(strip.absorbed).toBe(3);
    expect(aeDefragStripResting(strip)).toBe(true);
  });

  it("takes pills in on the spot with reduced motion", () => {
    const strip = aeCreateDefragStrip();
    const step = aeStepDefragStrip(strip, 200, 1, false, true);
    expect(step.launched).toHaveLength(1);
    expect(step.landed).toHaveLength(1);
    expect(strip.flying).toHaveLength(0);
    expect(strip.absorbed).toBe(1);
    expect(strip.messages[0].gone).toBe(true);
  });
});

describe("the cluster map", () => {
  it("frees what it reads and packs one summary cell per six reads", () => {
    const map = aeCreateDefragMap();
    const total = map.messages.length;
    expect(map.cells.filter((cell) => cell === "unmovable")).toHaveLength(34);
    expect(map.cells.filter((cell) => cell === "buffer")).toHaveLength(36);
    const changed = aeTickDefragMap(map, 12);
    expect(changed.length).toBeGreaterThan(0);
    // The first writes land on cells this same tick just read, so count the lists.
    expect(map.reading).toHaveLength(12);
    expect(map.writing).toHaveLength(2);
    aeTickDefragMap(map, total);
    aeTickDefragMap(map, total);
    expect(map.cells.filter((cell) => cell === "message")).toHaveLength(0);
    expect(map.cells.filter((cell) => cell === "summary")).toHaveLength(Math.ceil(total / 6));
    expect(map.cells[34]).toBe("summary");
  });
});

describe("the token defrag preference", () => {
  it("is on unless switched off", () => {
    expect(readAeTokenDefrag()).toBe(true);
    writeAeTokenDefrag(false);
    expect(window.localStorage.getItem(AE_TOKEN_DEFRAG_KEY)).toBe("off");
    expect(readAeTokenDefrag()).toBe(false);
    writeAeTokenDefrag(true);
    expect(readAeTokenDefrag()).toBe(true);
  });
});

describe("compaction totals", () => {
  it("gives each live marker the compaction noted just before it landed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    aeNoteCompactionTotals("conv", 168_000, 51_000);
    // Older than any note, or loaded from history: no counts.
    expect(aeCompactionTotalsFor("conv", 90)).toBeNull();
    expect(aeCompactionTotalsFor("conv", null)).toBeNull();
    expect(aeCompactionTotalsFor("conv", 100)).toEqual({ before: 168_000, after: 51_000 });
    // A later compaction leaves the earlier marker's counts alone, rendered or not.
    vi.setSystemTime(200_000);
    aeNoteCompactionTotals("conv", 150_000, 40_000);
    expect(aeCompactionTotalsFor("conv", 100)).toEqual({ before: 168_000, after: 51_000 });
    expect(aeCompactionTotalsFor("conv", 200)).toEqual({ before: 150_000, after: 40_000 });
    expect(aeCompactionTotalsFor("other", 200)).toBeNull();
  });

  it("shows no counts for a compaction that reported none, not the previous ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    aeNoteCompactionTotals("conv", 168_000, 51_000);
    expect(aeNotedCompactionTotals("conv")).toEqual({ before: 168_000, after: 51_000 });
    vi.setSystemTime(200_000);
    aeNoteCompactionTotals("conv", null, 51_000);
    expect(aeCompactionTotalsFor("conv", 200)).toBeNull();
    expect(aeNotedCompactionTotals("conv")).toBeNull();
    vi.setSystemTime(300_000);
    aeNoteCompactionTotals("conv", 168_000, undefined);
    expect(aeCompactionTotalsFor("conv", 300)).toBeNull();
    expect(aeCompactionTotalsFor("conv", 100)).toEqual({ before: 168_000, after: 51_000 });
    expect(aeNotedCompactionTotals(null)).toBeNull();
  });

  it("takes the before count from the stream tap, ahead of the store's update", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const read = () => ({ aeProgress: null, sessionStatus: "running", tokensUsed: 168_000 });
    aeObserveStreamEvent(
      { type: "compaction_completed", totalTokens: 51_000 },
      "conv",
      () => {},
      read,
    );
    expect(aeCompactionTotalsFor("conv", 100)).toEqual({ before: 168_000, after: 51_000 });
    aeObserveStreamEvent({ type: "compaction_failed" }, "conv", () => {}, read);
    expect(aeCompactionCountsFor("conv")).toEqual({ completed: 1, failed: 1 });
    expect(aeCompactionCountsFor("other")).toEqual({ completed: 0, failed: 0 });
  });

  it("counts finishes and failures per conversation", () => {
    aeNoteCompactionTotals("conv", null, null);
    aeNoteCompactionFailed("conv");
    aeNoteCompactionFailed("conv");
    expect(aeCompactionCountsFor("conv")).toEqual({ completed: 1, failed: 2 });
    expect(aeCompactionCountsFor(null)).toEqual({ completed: 0, failed: 0 });
  });
});
