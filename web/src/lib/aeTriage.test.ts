import { describe, expect, it } from "vitest";
import { AE_STATUS_VALUES } from "@/lib/aeLabels";
import { AE_STATUS_WORDS } from "@/components/AeStatusIcon";
import {
  AE_TRIAGE_GROUPS,
  AE_TRIAGE_STATUS,
  type AeTriageGroup,
  aeGroupCounts,
  aeSortByTriage,
  aeTriageGroupOf,
} from "./aeTriage";

const row = (status?: string, pending = 0) => ({
  id: `id-${status ?? "none"}-${pending}`,
  labels: (status === undefined ? {} : { "ae.status": status }) as Record<string, string>,
  pending_elicitations_count: pending,
});

describe("aeTriageGroupOf", () => {
  it("groups by the shown status, in the triage order", () => {
    expect(AE_TRIAGE_GROUPS).toEqual([
      "Blocked",
      "Working",
      "Review",
      "No status",
      "Parked",
      "Reference",
    ]);
    for (const status of AE_STATUS_VALUES) {
      expect(aeTriageGroupOf(row(status), null)).toBe(AE_STATUS_WORDS[status]);
      expect(AE_TRIAGE_STATUS[AE_STATUS_WORDS[status] as AeTriageGroup]).toBe(status);
    }
  });

  it("puts a working session waiting on an approval under Blocked", () => {
    expect(aeTriageGroupOf(row("working", 1), null)).toBe("Blocked");
  });

  it("puts a missing, blank or unknown status under No status", () => {
    expect(aeTriageGroupOf(row(), null)).toBe("No status");
    expect(aeTriageGroupOf(row(" "), null)).toBe("No status");
    expect(aeTriageGroupOf(row("someday"), null)).toBe("No status");
  });

  it("holds the first group while a frozen map is passed", () => {
    const frozen = new Map<string, AeTriageGroup>();
    const session = row("working");
    expect(aeTriageGroupOf(session, frozen)).toBe("Working");
    expect(aeTriageGroupOf({ ...session, labels: { "ae.status": "review" } }, frozen)).toBe(
      "Working",
    );
    expect(aeTriageGroupOf({ ...session, labels: { "ae.status": "review" } }, null)).toBe("Review");
  });
});

describe("aeSortByTriage", () => {
  const at = (id: string, status?: string, pending = 0) => ({ ...row(status, pending), id });

  it("sorts by the shown status and keeps the incoming order within one", () => {
    const rows = [
      at("ref", "reference"),
      at("w1", "working"),
      at("none"),
      at("r", "review"),
      at("w2", "working"),
      at("blk", "working", 1),
      at("p", "parked"),
    ];
    expect(aeSortByTriage(rows, null).map((r) => r.id)).toEqual([
      "blk",
      "w1",
      "w2",
      "r",
      "none",
      "p",
      "ref",
    ]);
    expect(rows.map((r) => r.id)[0]).toBe("ref");
  });

  it("holds each row's group while a frozen map is passed", () => {
    const frozen = new Map<string, AeTriageGroup>();
    aeSortByTriage([at("a", "review"), at("b", "working")], frozen);
    const changed = [at("a", "working"), at("b", "review")];
    expect(aeSortByTriage(changed, frozen).map((r) => r.id)).toEqual(["b", "a"]);
    expect(aeSortByTriage(changed, null).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("aeGroupCounts", () => {
  it("counts rows per title", () => {
    const counts = aeGroupCounts(
      new Map([
        ["a", "Working"],
        ["b", "Working"],
        ["c", "Review"],
      ]),
    );
    expect(Object.fromEntries(counts)).toEqual({ Working: 2, Review: 1 });
    expect(aeGroupCounts(null).size).toBe(0);
  });
});
