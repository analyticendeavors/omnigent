// Parses the slot cap's warn-mode ask text into parts so the approval card can show the
// question and its buttons first and fold the holder list (omnigent-ae, 2026-10-29: the
// card was one run-on paragraph and the buttons fell off a 390 px phone).
//
// The text is built by `reason_text` in packages/ae_omni_policies/.../slot_cap.py and joined
// with single spaces, not newlines, so this splits on the known sentences and row numbers.
// Block-mode text ("Slots full: N of M taken; this one would make ...") is a denial, not an
// ask, and returns null. Anything that does not match returns null and the card renders the
// text as before.

export interface AeSlotsFullRow {
  title: string;
  /** "elapsed 1d 4h" or "next: do x"; empty when the row has no trailing detail. */
  detail: string;
}

export interface AeSlotsFull {
  headline: string;
  rows: AeSlotsFullRow[];
  /** "To park one instead, the longest running: A or B."; empty when absent. */
  park: string;
  /** "Plus N of another user's.", "N more claimed ...", and the Accept sentence, in order. */
  tail: string[];
}

const HEADLINE = /^Slots full: (\d+) of \d+ taken\. Run this as the [^?]+\?/;
const ACCEPT = " Accept to run it as overflow, or decline, then ";
const PARK = " To park one instead, the longest running: ";
const PENDING = /\s((\d+) more claimed a slot a moment ago\.)$/;
const OTHERS = /\s(Plus \d+ of another user's\.)$/;
const ELAPSED_TAIL = /^(.*) \((elapsed [^()]*)\)$/s;
const NEXT_MARK = " (next: ";

/** Split a row at its last trailing "(elapsed ...)" or "(next: ...)"; null when it has neither. */
function parseRow(text: string): AeSlotsFullRow | null {
  const elapsed = ELAPSED_TAIL.exec(text);
  const nextAt = text.lastIndexOf(NEXT_MARK);
  const nextOk = nextAt > 0 && text.endsWith(")");
  if (elapsed && (!nextOk || elapsed[1].length >= nextAt)) {
    return { title: elapsed[1], detail: elapsed[2] };
  }
  if (nextOk) return { title: text.slice(0, nextAt), detail: text.slice(nextAt + 2, -1) };
  return null;
}

/**
 * The rows text is "1. A (x) 2. B (y)". A title may hold ") 2. " itself, so the text is
 * ambiguous; try every boundary and keep the first split with exactly `expected` rows,
 * each ending in a real detail.
 */
function parseRows(text: string, expected: number): AeSlotsFullRow[] | null {
  const walk = (index: number, cursor: number): AeSlotsFullRow[] | null => {
    const marker = `${index}. `;
    if (!text.startsWith(marker, cursor)) return null;
    const start = cursor + marker.length;
    if (index === expected) {
      const row = parseRow(text.slice(start));
      return row ? [row] : null;
    }
    const boundary = `) ${index + 1}. `;
    for (let at = text.indexOf(boundary, start); at !== -1; at = text.indexOf(boundary, at + 1)) {
      const row = parseRow(text.slice(start, at + 1));
      if (!row) continue;
      const rest = walk(index + 1, at + 2);
      if (rest) return [row, ...rest];
    }
    return null;
  };
  return expected === 0 ? (text === "" ? [] : null) : walk(1, 0);
}

export function parseAeSlotsFull(text: string): AeSlotsFull | null {
  const head = HEADLINE.exec(text);
  if (!head) return null;
  let rest = text.slice(head[0].length);
  const tail: string[] = [];
  const acceptAt = rest.lastIndexOf(ACCEPT);
  if (acceptAt === -1) return null;
  tail.unshift(rest.slice(acceptAt + 1));
  rest = rest.slice(0, acceptAt);
  let park = "";
  const parkAt = rest.lastIndexOf(PARK);
  if (parkAt !== -1) {
    park = rest.slice(parkAt + 1);
    rest = rest.slice(0, parkAt);
  }
  let pendingCount = 0;
  const pending = PENDING.exec(rest);
  if (pending) {
    tail.unshift(pending[1]);
    pendingCount = Number(pending[2]);
    rest = rest.slice(0, pending.index);
  }
  const others = OTHERS.exec(rest);
  if (others) {
    tail.unshift(others[1]);
    rest = rest.slice(0, others.index);
  }
  // "N of M taken" counts the holders plus the claims made a moment ago.
  const expected = Number(head[1]) - pendingCount;
  if (expected < 0) return null;
  const rows = parseRows(rest.trim(), expected);
  if (!rows) return null;
  return { headline: head[0], rows, park, tail };
}
