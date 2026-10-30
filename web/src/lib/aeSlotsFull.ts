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

const HEADLINE = /^Slots full: \d+ of \d+ taken\. Run this as the [^?]+\?/;
const ACCEPT = " Accept to run it as overflow, or decline, then ";
const PARK = " To park one instead, the longest running: ";
const PENDING = /\s(\d+ more claimed a slot a moment ago\.)$/;
const OTHERS = /\s(Plus \d+ of another user's\.)$/;
const ELAPSED_ROW = /^(.*) \((elapsed [^()]*)\)$/s;
const NEXT_ROW = /^(.*?) \((next: .*)\)$/s;

function parseRow(text: string): AeSlotsFullRow {
  const match = ELAPSED_ROW.exec(text) ?? NEXT_ROW.exec(text);
  return match ? { title: match[1], detail: match[2] } : { title: text, detail: "" };
}

/** The rows text is "1. A (x) 2. B (y)"; each row ends where ") N+1. " begins. */
function parseRows(text: string): AeSlotsFullRow[] | null {
  const rows: AeSlotsFullRow[] = [];
  let index = 1;
  let cursor = 0;
  while (cursor < text.length) {
    const marker = `${index}. `;
    if (!text.startsWith(marker, cursor)) return null;
    const start = cursor + marker.length;
    const boundary = text.indexOf(`) ${index + 1}. `, start);
    const end = boundary === -1 ? text.length : boundary + 1;
    rows.push(parseRow(text.slice(start, end)));
    cursor = boundary === -1 ? text.length : end + 1;
    index += 1;
  }
  return rows;
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
  const pending = PENDING.exec(rest);
  if (pending) {
    tail.unshift(pending[1]);
    rest = rest.slice(0, pending.index);
  }
  const others = OTHERS.exec(rest);
  if (others) {
    tail.unshift(others[1]);
    rest = rest.slice(0, others.index);
  }
  const body = rest.trim();
  const rows = body ? parseRows(body) : [];
  if (!rows) return null;
  return { headline: head[0], rows, park, tail };
}
