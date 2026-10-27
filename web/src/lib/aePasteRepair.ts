// An iPhone can hand the composer a copied note as a percent-encoded URL: text
// that opens with `Word: ` parses as a URL with a scheme, so the clipboard comes
// back lowercased with every space and newline as %20 and %0A
// ("THREAD: a\nNEXT: b" arrives as "thread:%20a%0ANEXT:%20b"). Real URLs never
// carry an encoded space right after the scheme colon, so that shape is safe to
// undo. The scheme's case is lost for good; everything else is restored.

const ENCODED_NOTE = /^[a-z][a-z0-9+.-]*:(?:%20|%0A)\S*$/;
// A note has many words; a custom URL with one escaped space (obsidian:%20Note)
// is left alone.
const ESCAPED_BREAK = /%20|%0A/g;

/** The decoded text for a note the clipboard encoded as a URL, else null. */
export function repairEncodedNote(pasted: string): string | null {
  const text = pasted.trim();
  if (!ENCODED_NOTE.test(text)) return null;
  if ((text.match(ESCAPED_BREAK)?.length ?? 0) < 3) return null;
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}
